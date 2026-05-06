// P2-T06 — `loops.*` router (mutation surface). Phase 2 ships only the
// inline approve / reject buttons that render on `/tasks/[id]` when a
// task belongs to a loop sitting in `pending_approval=true`. The
// `/loops` page (list / get / cancel / start) is deferred to Phase 3.
//
// Architecture — both procedures are server-confirmed (no optimistic
// UI per PHASE-2-REVIEW §d.1). The wire shape mirrors v1 ARCH §4.3:
//
//   loops.approve({ loopId }) → { ok: true, alreadyFinalized }
//   loops.reject({ loopId, reason? }) → { ok: true, alreadyFinalized }
//
// Idempotency / multi-channel race (T06 acceptance criterion 5 + 9):
//
//   1. Server-side check: lookup the loop row and short-circuit when
//      `pending_approval=false` — Telegram or another tab already
//      finalized the loop. No MCP call, one audit row recording the
//      no-op.
//   2. Daemon-side race: when `bridge_loop_*` throws
//      MCP_RPC_ERROR with a message matching the race regex
//      (`already approved/rejected/finalized/...`), swallow → return
//      `alreadyFinalized:true`. Audit payload carries
//      `raceDetected:true` for forensics.
//
// Privacy — `reason` text is forwarded to the daemon but **never**
// echoed into `audit_log.payload_json`. The audit row records
// `hasReason: true` so the audit viewer can correlate against the
// loop row's daemon-side feedback column.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, lt } from "drizzle-orm";

import { publicProcedure, router } from "../trpc";
import { getDb } from "../db";
import { loops, loopIterations } from "../../db/schema";
import { appendAudit } from "../audit";
import { McpPoolError } from "../mcp/pool";
import { auditFailureCode, mapMcpErrorToTrpc } from "../mcp/errors";
import type {
  LoopApproveResult,
  LoopDetail,
  LoopIterationRow,
  LoopListPage,
  LoopRejectResult,
  LoopStartResult,
} from "../dto";

// P3-T1 — `loops.list` input. Read-only query over the vendored
// `loops` table. `status` accepts the daemon's literal column values
// (`running`, `done`, `cancelled`, `failed`) plus a synthetic
// `waiting_approval` sentinel that maps to `pending_approval=true`
// (the daemon keeps `status` at "running" while waiting for a human).
//
// `cursor` is the `started_at` ISO string of the oldest row on the
// previous page — `started_at` is TEXT in the daemon schema and ISO-
// 8601 sorts identically to natural date order under SQLite's lex
// comparison. `limit` clamps at 100 (well below the
// no-virtualization threshold per v1 ARCH §11).
const ListInput = z.object({
  status: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

const LIST_DTO_SELECTION = {
  loopId: loops.loopId,
  agent: loops.agent,
  status: loops.status,
  loopType: loops.loopType,
  currentIteration: loops.currentIteration,
  maxIterations: loops.maxIterations,
  totalCostUsd: loops.totalCostUsd,
  maxCostUsd: loops.maxCostUsd,
  pendingApproval: loops.pendingApproval,
  startedAt: loops.startedAt,
  finishedAt: loops.finishedAt,
  finishReason: loops.finishReason,
} as const;

// P3-T2 — `loops.get` input. Single loop_id; the procedure returns
// `null` for unknown ids so the page can call `notFound()` rather
// than catching a TRPCError. Mirrors `tasks.get` (Phase 1 T06).
const GetInput = z.object({
  loopId: z.string().min(1).max(128),
});

// Cap on iterations returned by `loops.get`. Most loops never come
// near this — the daemon's `max_iterations` defaults to 10 and we've
// never seen one above 50 in the wild. The cap is the safety net for
// the rare runaway. Mirrors the `clipUtf8` cap in `tasks.get`: we
// keep the page renderable rather than letting a single huge row
// blow the FCP budget.
const LOOP_ITERATIONS_LIMIT = 100;

const ITER_DTO_SELECTION = {
  id: loopIterations.id,
  iterationNum: loopIterations.iterationNum,
  taskId: loopIterations.taskId,
  prompt: loopIterations.prompt,
  resultSummary: loopIterations.resultSummary,
  doneCheckPassed: loopIterations.doneCheckPassed,
  costUsd: loopIterations.costUsd,
  startedAt: loopIterations.startedAt,
  finishedAt: loopIterations.finishedAt,
  status: loopIterations.status,
} as const;

const DETAIL_DTO_SELECTION = {
  loopId: loops.loopId,
  agent: loops.agent,
  project: loops.project,
  goal: loops.goal,
  doneWhen: loops.doneWhen,
  loopType: loops.loopType,
  status: loops.status,
  maxIterations: loops.maxIterations,
  currentIteration: loops.currentIteration,
  totalCostUsd: loops.totalCostUsd,
  maxCostUsd: loops.maxCostUsd,
  pendingApproval: loops.pendingApproval,
  startedAt: loops.startedAt,
  finishedAt: loops.finishedAt,
  finishReason: loops.finishReason,
  currentTaskId: loops.currentTaskId,
  channel: loops.channel,
  channelChatId: loops.channelChatId,
  planEnabled: loops.planEnabled,
  passThreshold: loops.passThreshold,
  consecutivePasses: loops.consecutivePasses,
  consecutiveFailures: loops.consecutiveFailures,
} as const;

// P3-T3 — `loops.start` input. Mirrors the daemon `bridge_loop` MCP
// tool surface (see CLAUDE.md) trimmed to what the dialog sends.
//
// `goal` 32_000-char cap matches `tasks.dispatch.prompt` (Phase 2 T01)
// — well above any human goal and below stdio framing concerns. The
// goal text is forwarded to the daemon but **never** echoed into
// `audit_log.payload_json` (privacy precedent §c — same rule the audit
// log applies to dispatch prompts and reject reasons). Audit records
// `hasGoal: true` instead.
//
// `doneWhen` validation runs both client-side (UX feedback) and here
// — the daemon's `LoopEvaluator` accepts any of `command:`,
// `file_exists:`, `file_contains:`, `llm_judge:`, or `manual:` prefix.
// Empty body after the prefix (e.g. `manual:`) is intentional — the
// daemon treats it as a marker.
const DONE_WHEN_PATTERN =
  /^(command|file_exists|file_contains|llm_judge|manual):.*$/;

const StartInput = z.object({
  agentName: z.string().min(1).max(128),
  goal: z.string().min(1).max(32_000),
  doneWhen: z
    .string()
    .min(1)
    .max(2_000)
    .regex(DONE_WHEN_PATTERN, "doneWhen must start with command:, file_exists:, file_contains:, llm_judge:, or manual:"),
  maxIterations: z.number().int().min(1).max(200).optional(),
  maxCostUsd: z.number().positive().max(10_000).optional(),
  loopType: z.enum(["bridge", "agent", "auto"]).optional(),
  planFirst: z.boolean().optional(),
  passThreshold: z.number().int().min(1).max(10).optional(),
  channelChatId: z.string().min(1).max(128).optional(),
});

const LOOP_START_TIMEOUT_MS = 15_000;

interface BridgeLoopResult {
  loop_id?: unknown;
  content?: unknown;
}

// Daemon's `bridge_loop` returns the MCP `text()` envelope —
// `{ content: [{ type: "text", text: "Started loop <id>" }] }`. The
// in-process tests inject `{ loop_id: "..." }` directly. Accept
// either; return null if neither shape yields a valid id so the
// procedure can audit `malformed_response` cleanly.
function extractLoopId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as BridgeLoopResult;
  if (typeof v.loop_id === "string" && v.loop_id.length > 0) {
    return v.loop_id;
  }
  if (Array.isArray(v.content)) {
    for (const part of v.content) {
      if (part === null || typeof part !== "object") continue;
      const p = part as { type?: unknown; text?: unknown };
      if (p.type !== "text" || typeof p.text !== "string") continue;
      const m = p.text.match(/Started loop\s+(\S+)/);
      if (m && m[1]!.length > 0) return m[1]!;
    }
  }
  return null;
}

const ApproveInput = z.object({
  loopId: z.string().min(1).max(128),
});

const RejectInput = z.object({
  loopId: z.string().min(1).max(128),
  reason: z.string().min(1).max(1000).optional(),
});

const LOOP_TIMEOUT_MS = 15_000;

// Daemon-reported messages we treat as a benign race rather than a
// failure. The match is intentionally narrow:
//   - `already (approved|rejected|finalized|finished|done|cancelled)`
//   - `(loop )?not pending approval`
// Generic errors like `connection refused` or `agent not found` do
// **not** match → propagate as `INTERNAL_SERVER_ERROR`.
const LOOP_RACE_PATTERN =
  /already.*(approved|rejected|finalized|finished|done|cancell?ed)|loop.*not.*pending|not.*pending.*approval/i;

interface LoopRow {
  status: string | null;
  pendingApproval: boolean;
}

function lookupLoop(loopId: string): LoopRow | undefined {
  const db = getDb();
  return db
    .select({ status: loops.status, pendingApproval: loops.pendingApproval })
    .from(loops)
    .where(eq(loops.loopId, loopId))
    .limit(1)
    .all()[0];
}

export const loopsRouter = router({
  // P3-T1 — list loops with optional `status` / `agent` filters and
  // started_at-DESC cursor pagination. Read-only — no MCP, no audit
  // (queries are not audited per Phase 2 scope decision).
  //
  // Filtering on `status="waiting_approval"` is the only synthetic
  // case: the daemon keeps `loops.status="running"` while waiting on
  // a human, so we map the sentinel to `pending_approval=true`.
  list: publicProcedure
    .input(ListInput)
    .query(({ input }): LoopListPage => {
      const db = getDb();

      const filters = [];
      if (input.agent !== undefined) {
        filters.push(eq(loops.agent, input.agent));
      }
      if (input.status !== undefined) {
        if (input.status === "waiting_approval") {
          filters.push(eq(loops.pendingApproval, true));
        } else {
          filters.push(eq(loops.status, input.status));
        }
      }
      if (input.cursor !== undefined) {
        filters.push(lt(loops.startedAt, input.cursor));
      }

      const items = db
        .select(LIST_DTO_SELECTION)
        .from(loops)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(loops.startedAt))
        .limit(input.limit)
        .all();

      const nextCursor =
        items.length === input.limit
          ? (items[items.length - 1]!.startedAt ?? null)
          : null;
      return { items, nextCursor };
    }),

  // P3-T2 — fetch one loop + its iteration history. Returns `null`
  // for unknown loop_id so the page can `notFound()` cleanly. The
  // iteration list is the most-recent `LOOP_ITERATIONS_LIMIT` rows
  // returned in ascending `iteration_num` order so the timeline +
  // sparkline read left-to-right naturally.
  //
  // Read-only — no MCP, no audit (queries are not audited per Phase
  // 2 scope decision). The detail page polls every 2s for live
  // updates per INDEX caveat (multiplexed `/api/stream` is filed
  // against Phase 4).
  get: publicProcedure
    .input(GetInput)
    .query(({ input }): LoopDetail | null => {
      const db = getDb();
      const row = db
        .select(DETAIL_DTO_SELECTION)
        .from(loops)
        .where(eq(loops.loopId, input.loopId))
        .limit(1)
        .all()[0];
      if (!row) return null;

      const totalIterations = (
        db
          .select({ id: loopIterations.id })
          .from(loopIterations)
          .where(eq(loopIterations.loopId, input.loopId))
          .all() as Array<{ id: number }>
      ).length;

      // Pull the most-recent N rows DESC (so we never load more
      // than the cap into memory), then reverse client-side to
      // present an ASC timeline. SQLite doesn't have a "tail" so
      // this is the standard 2-step pattern.
      const recentDesc = db
        .select(ITER_DTO_SELECTION)
        .from(loopIterations)
        .where(eq(loopIterations.loopId, input.loopId))
        .orderBy(desc(loopIterations.iterationNum))
        .limit(LOOP_ITERATIONS_LIMIT)
        .all();
      const iterations: LoopIterationRow[] = recentDesc.slice().reverse();

      return {
        ...row,
        iterations,
        iterationsTruncated: totalIterations > LOOP_ITERATIONS_LIMIT,
        totalIterations,
      };
    }),

  // P3-T3 — start a new goal loop via the daemon's `bridge_loop`
  // MCP tool. Same shape as Phase 2 T01 `tasks.dispatch`: CSRF +
  // rate-limit guards run at the route handler; this procedure
  // handles the audit row + error mapping. We never insert into the
  // `loops` table directly — the daemon owns loop lifecycle.
  //
  // Audit shape (privacy precedent §c — goal text NEVER echoed):
  //   success → action="loop.start", resource_id=loopId,
  //             payload={ agentName, doneWhen, maxIterations?,
  //                       maxCostUsd?, loopType?, planFirst?,
  //                       passThreshold?, hasGoal:true,
  //                       hasChannelChatId? }
  //   failure → action="loop.start.error", resource_id=null,
  //             payload={ agentName, doneWhen, code }
  //
  // The `goal` text is `bridge_loop`'s primary input — the daemon
  // writes it to `loops.goal` so the audit row stays a minimal index,
  // not a duplicate. Same rule we apply to `tasks.dispatch.prompt`
  // and `loops.reject.reason`.
  start: publicProcedure
    .input(StartInput)
    .mutation(async ({ input, ctx }): Promise<LoopStartResult> => {
      if (!ctx.mcp) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "MCP client not configured on tRPC context",
        });
      }

      const params: {
        agent: string;
        goal: string;
        done_when: string;
        max_iterations?: number;
        max_cost_usd?: number;
        loop_type?: string;
        plan_first?: boolean;
        pass_threshold?: number;
        chat_id?: string;
        user_id?: string;
      } = {
        agent: input.agentName,
        goal: input.goal,
        done_when: input.doneWhen,
      };
      if (input.maxIterations !== undefined) params.max_iterations = input.maxIterations;
      if (input.maxCostUsd !== undefined) params.max_cost_usd = input.maxCostUsd;
      if (input.loopType !== undefined) params.loop_type = input.loopType;
      if (input.planFirst !== undefined) params.plan_first = input.planFirst;
      if (input.passThreshold !== undefined) params.pass_threshold = input.passThreshold;
      if (input.channelChatId !== undefined) params.chat_id = input.channelChatId;
      if (ctx.userId !== undefined && ctx.userId !== null) params.user_id = ctx.userId;

      const auditBase = {
        resourceType: "loop" as const,
        userId: ctx.userId ?? null,
        req: ctx.req,
      };

      // Audit failure-payload base — `goal` is intentionally absent;
      // the dialog form sends it to the daemon but the audit only
      // records the metadata fields the user can reasonably want to
      // forensically replay later. `hasGoal:true` is the privacy
      // sentinel that says "yes the daemon got a goal value".
      const failurePayloadBase: Record<string, unknown> = {
        agentName: input.agentName,
        doneWhen: input.doneWhen,
      };
      if (input.maxIterations !== undefined) failurePayloadBase.maxIterations = input.maxIterations;
      if (input.maxCostUsd !== undefined) failurePayloadBase.maxCostUsd = input.maxCostUsd;
      if (input.loopType !== undefined) failurePayloadBase.loopType = input.loopType;
      if (input.planFirst !== undefined) failurePayloadBase.planFirst = input.planFirst;
      if (input.passThreshold !== undefined) failurePayloadBase.passThreshold = input.passThreshold;

      let result: unknown;
      try {
        result = await ctx.mcp.call("bridge_loop", params, {
          timeoutMs: LOOP_START_TIMEOUT_MS,
        });
      } catch (err) {
        appendAudit({
          ...auditBase,
          action: "loop.start.error",
          resourceId: null,
          payload: {
            ...failurePayloadBase,
            code: auditFailureCode(err),
          },
        });
        throw mapMcpErrorToTrpc(err);
      }

      const loopId = extractLoopId(result);
      if (loopId === null) {
        appendAudit({
          ...auditBase,
          action: "loop.start.error",
          resourceId: null,
          payload: {
            ...failurePayloadBase,
            code: "malformed_response",
          },
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "daemon returned malformed loop start response",
        });
      }

      const successPayload: Record<string, unknown> = {
        agentName: input.agentName,
        doneWhen: input.doneWhen,
        hasGoal: true,
      };
      if (input.maxIterations !== undefined) successPayload.maxIterations = input.maxIterations;
      if (input.maxCostUsd !== undefined) successPayload.maxCostUsd = input.maxCostUsd;
      if (input.loopType !== undefined) successPayload.loopType = input.loopType;
      if (input.planFirst !== undefined) successPayload.planFirst = input.planFirst;
      if (input.passThreshold !== undefined) successPayload.passThreshold = input.passThreshold;
      if (input.channelChatId !== undefined) successPayload.hasChannelChatId = true;

      appendAudit({
        ...auditBase,
        action: "loop.start",
        resourceId: loopId,
        payload: successPayload,
      });

      return { loopId };
    }),

  // P2-T06 — approve a loop sitting in `pending_approval=true`.
  // Server-confirmed (no optimistic UI). Calls daemon's
  // `bridge_loop_approve({ loop_id })` MCP tool via the T12 pool.
  approve: publicProcedure
    .input(ApproveInput)
    .mutation(async ({ input, ctx }): Promise<LoopApproveResult> => {
      if (!ctx.mcp) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "MCP client not configured on tRPC context",
        });
      }

      const row = lookupLoop(input.loopId);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "loop not found",
        });
      }

      const auditBase = {
        resourceType: "loop" as const,
        resourceId: input.loopId,
        userId: ctx.userId ?? null,
        req: ctx.req,
      };

      // Path A — server-side finalized check, no MCP call.
      if (!row.pendingApproval) {
        appendAudit({
          ...auditBase,
          action: "loop.approve",
          payload: {
            status: row.status,
            alreadyFinalized: true,
          },
        });
        return { ok: true, alreadyFinalized: true };
      }

      // Path B — call the daemon.
      try {
        await ctx.mcp.call(
          "bridge_loop_approve",
          { loop_id: input.loopId },
          { timeoutMs: LOOP_TIMEOUT_MS },
        );
      } catch (err) {
        if (
          err instanceof McpPoolError &&
          err.code === "MCP_RPC_ERROR" &&
          LOOP_RACE_PATTERN.test(err.message)
        ) {
          appendAudit({
            ...auditBase,
            action: "loop.approve",
            payload: {
              status: row.status,
              alreadyFinalized: true,
              raceDetected: true,
            },
          });
          return { ok: true, alreadyFinalized: true };
        }
        appendAudit({
          ...auditBase,
          action: "loop.approve.error",
          payload: {
            status: row.status,
            code: auditFailureCode(err),
          },
        });
        throw mapMcpErrorToTrpc(err);
      }

      appendAudit({
        ...auditBase,
        action: "loop.approve",
        payload: {
          status: row.status,
          alreadyFinalized: false,
        },
      });
      return { ok: true, alreadyFinalized: false };
    }),

  // P2-T06 — reject a loop sitting in `pending_approval=true`. The
  // optional `reason` is forwarded to the daemon as `feedback` but
  // **never** persisted in `audit_log.payload_json` (may carry
  // user-private rationale).
  reject: publicProcedure
    .input(RejectInput)
    .mutation(async ({ input, ctx }): Promise<LoopRejectResult> => {
      if (!ctx.mcp) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "MCP client not configured on tRPC context",
        });
      }

      const row = lookupLoop(input.loopId);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "loop not found",
        });
      }

      const auditBase = {
        resourceType: "loop" as const,
        resourceId: input.loopId,
        userId: ctx.userId ?? null,
        req: ctx.req,
      };

      // Path A — server-side finalized check, no MCP call. Audit
      // payload omits the reason text; `hasReason` is also dropped on
      // this path because the daemon never received it.
      if (!row.pendingApproval) {
        appendAudit({
          ...auditBase,
          action: "loop.reject",
          payload: {
            status: row.status,
            alreadyFinalized: true,
          },
        });
        return { ok: true, alreadyFinalized: true };
      }

      // Build daemon params — only pass `feedback` when the caller
      // actually supplied a reason. Absence of the key is a meaningful
      // signal to the daemon ("rejected without rationale").
      const params: { loop_id: string; feedback?: string } = {
        loop_id: input.loopId,
      };
      if (input.reason !== undefined) params.feedback = input.reason;

      try {
        await ctx.mcp.call("bridge_loop_reject", params, {
          timeoutMs: LOOP_TIMEOUT_MS,
        });
      } catch (err) {
        if (
          err instanceof McpPoolError &&
          err.code === "MCP_RPC_ERROR" &&
          LOOP_RACE_PATTERN.test(err.message)
        ) {
          appendAudit({
            ...auditBase,
            action: "loop.reject",
            payload: {
              status: row.status,
              alreadyFinalized: true,
              raceDetected: true,
            },
          });
          return { ok: true, alreadyFinalized: true };
        }
        appendAudit({
          ...auditBase,
          action: "loop.reject.error",
          payload: {
            status: row.status,
            code: auditFailureCode(err),
          },
        });
        throw mapMcpErrorToTrpc(err);
      }

      const successPayload: Record<string, unknown> = {
        status: row.status,
        alreadyFinalized: false,
      };
      if (input.reason !== undefined) successPayload.hasReason = true;

      appendAudit({
        ...auditBase,
        action: "loop.reject",
        payload: successPayload,
      });
      return { ok: true, alreadyFinalized: false };
    }),
});
