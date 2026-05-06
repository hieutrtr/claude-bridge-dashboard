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
import { loops } from "../../db/schema";
import { appendAudit } from "../audit";
import { McpPoolError } from "../mcp/pool";
import { auditFailureCode, mapMcpErrorToTrpc } from "../mcp/errors";
import type {
  LoopApproveResult,
  LoopListPage,
  LoopRejectResult,
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
