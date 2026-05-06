// P3-T5 — `schedules.*` router. Phase 3 entry point for the recurring-
// schedule vertical: T5 ships `list` (read-only over the vendored
// `schedules` table), T6 adds `add` (mutation calling daemon MCP
// `bridge_schedule_add`). Pause/resume/delete land in T7.
//
// Wire shape — see `ScheduleListRow` / `ScheduleAddResult` in
// `src/server/dto.ts` for the curated column sets. No `cursor`
// pagination this iter: schedules are finite (humans manage them by
// hand; the median deployment will have < 50). If a deployment grows
// past the no-virtualization threshold we add cursor pagination as a
// follow-up — same shape as `loops.list` (started_at-DESC keyset).
//
// Read paths are read-only (no MCP, no audit — queries are not
// audited per Phase 2 scope decision). The mutation paths (T6 + T7)
// route through daemon MCP tools per Phase 3 INDEX invariant.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gt, isNotNull } from "drizzle-orm";

import { publicProcedure, router } from "../trpc";
import { getDb } from "../db";
import { agents, schedules, tasks } from "../../db/schema";
import { appendAudit } from "../audit";
import { auditFailureCode, mapMcpErrorToTrpc } from "../mcp/errors";
import { forecastSchedule } from "../../lib/cost-forecast";
import type {
  ScheduleAddResult,
  ScheduleCostForecast,
  ScheduleListPage,
  ScheduleListRow,
  ScheduleMutationResult,
  ScheduleRunRow,
  ScheduleRunsPage,
} from "../dto";

const ListInput = z.object({
  agent: z.string().min(1).optional(),
});

const LIST_DTO_SELECTION = {
  id: schedules.id,
  name: schedules.name,
  agentName: schedules.agentName,
  prompt: schedules.prompt,
  cronExpr: schedules.cronExpr,
  intervalMinutes: schedules.intervalMinutes,
  enabled: schedules.enabled,
  runOnce: schedules.runOnce,
  runCount: schedules.runCount,
  consecutiveErrors: schedules.consecutiveErrors,
  lastRunAt: schedules.lastRunAt,
  nextRunAt: schedules.nextRunAt,
  lastError: schedules.lastError,
  channel: schedules.channel,
  createdAt: schedules.createdAt,
} as const;

// The daemon writes BOOL columns as INTEGER 0/1 — Drizzle's
// `{ mode: "boolean" }` decoder normalises them, but the column
// defaults to `true` and may legitimately be `null` for rows the
// daemon migrated in from an older schema. Coerce to the strict
// boolean the wire shape promises so the table doesn't have to
// re-defensively normalise downstream.
function rowToDto(row: {
  id: number;
  name: string;
  agentName: string;
  prompt: string;
  cronExpr: string | null;
  intervalMinutes: number | null;
  enabled: boolean | null;
  runOnce: boolean | null;
  runCount: number | null;
  consecutiveErrors: number | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  channel: string | null;
  createdAt: string | null;
}): ScheduleListRow {
  return {
    id: row.id,
    name: row.name,
    agentName: row.agentName,
    prompt: row.prompt,
    cronExpr: row.cronExpr,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled === true,
    runOnce: row.runOnce === true,
    runCount: row.runCount ?? 0,
    consecutiveErrors: row.consecutiveErrors ?? 0,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    lastError: row.lastError,
    channel: row.channel,
    createdAt: row.createdAt,
  };
}

// P3-T6 — `schedules.add` input. Mirrors the daemon `bridge_schedule_add`
// MCP tool surface (see `claude-bridge/src/mcp/tools.ts:273-287`).
//
// `intervalMinutes` is the only cadence shape the daemon currently
// accepts; the cron picker converts cron expressions → interval
// client-side before submit, and the dashboard records the cron
// expression as audit metadata (the daemon ignores the field). Cap is
// 30 days (43_200 min) — well above any reasonable schedule cadence;
// guards against a stray "every year" entry overflowing scheduler math.
//
// `prompt` 32_000-char cap matches `tasks.dispatch.prompt` (Phase 2 T01)
// and `loops.start.goal` (P3-T3) — well above any human prompt and
// below stdio framing concerns. The prompt text is forwarded to the
// daemon but **never** echoed into `audit_log.payload_json` (privacy
// precedent §c). Audit records `hasPrompt: true` instead.
const AddInput = z.object({
  name: z.string().min(1).max(128).optional(),
  agentName: z.string().min(1).max(128),
  prompt: z.string().min(1).max(32_000),
  intervalMinutes: z.number().int().min(1).max(43_200),
  cronExpr: z.string().min(1).max(256).optional(),
  channelChatId: z.string().min(1).max(128).optional(),
});

const SCHEDULE_ADD_TIMEOUT_MS = 15_000;

interface BridgeScheduleAddResult {
  id?: unknown;
  content?: unknown;
}

// Daemon's `bridge_schedule_add` returns the MCP `text()` envelope —
// `{ content: [{ type: "text", text: "Schedule #42 created" }] }`. The
// in-process tests inject `{ id: 42 }` directly. Accept either; return
// null if neither shape yields a valid id so the procedure can audit
// `malformed_response` cleanly.
function extractScheduleId(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as BridgeScheduleAddResult;
  if (typeof v.id === "number" && Number.isInteger(v.id) && v.id > 0) {
    return v.id;
  }
  if (Array.isArray(v.content)) {
    for (const part of v.content) {
      if (part === null || typeof part !== "object") continue;
      const p = part as { type?: unknown; text?: unknown };
      if (p.type !== "text" || typeof p.text !== "string") continue;
      const m = p.text.match(/Schedule\s+#(\d+)\s+created/i);
      if (m && m[1]) {
        const n = Number(m[1]);
        if (Number.isInteger(n) && n > 0) return n;
      }
    }
  }
  return null;
}

// P3-T7 — input + helper for the pause/resume/remove triplet. Defined
// at module scope (above `schedulesRouter`) so the helper is fully
// initialised by the time the router-literal evaluates and binds each
// procedure. (Procedure expressions are eagerly evaluated; const
// hoisting only hoists the binding, not the value — moving the helper
// inline would crash with TDZ.)
const ScheduleActionInput = z.object({
  id: z.number().int().positive(),
});

type ScheduleAction = "pause" | "resume" | "remove";
const SCHEDULE_TOOL_BY_ACTION: Record<ScheduleAction, string> = {
  pause: "bridge_schedule_pause",
  resume: "bridge_schedule_resume",
  remove: "bridge_schedule_remove",
};

interface ScheduleLookupRow {
  id: number;
  name: string;
  agentName: string;
}

function lookupSchedule(id: number): ScheduleLookupRow | null {
  const db = getDb();
  const rows = db
    .select({
      id: schedules.id,
      name: schedules.name,
      agentName: schedules.agentName,
    })
    .from(schedules)
    .where(eq(schedules.id, id))
    .limit(1)
    .all();
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    id: row.id,
    name: row.name,
    agentName: row.agentName,
  };
}

// P3-T8 — `schedules.runs` input. Read-only join across schedules +
// agents + tasks. The daemon does not carry `schedule_id` on tasks
// (see `claude-bridge/src/orchestration/scheduler.ts:80-88`), so the
// link is heuristic: `tasks.session_id == agents.session_id` for the
// schedule's `agent_name` AND `tasks.prompt == schedules.prompt` AND
// `tasks.channel == schedules.channel`. Documented in T08-review.md.
const RunsInput = z.object({
  id: z.number().int().positive(),
  limit: z.number().int().min(1).max(100).default(30),
});

const SCHEDULE_RUN_DTO_SELECTION = {
  id: tasks.id,
  status: tasks.status,
  costUsd: tasks.costUsd,
  durationMs: tasks.durationMs,
  channel: tasks.channel,
  createdAt: tasks.createdAt,
  completedAt: tasks.completedAt,
} as const;

interface ScheduleRunsLookupRow {
  id: number;
  name: string;
  agentName: string;
  prompt: string;
  channel: string | null;
}

// P3-T9 — `schedules.costForecast` input. At least one of
// `intervalMinutes` or `cronExpr` must be supplied (the Zod refine
// below enforces this — neither = BAD_REQUEST). The helper at
// `src/lib/cost-forecast.ts` decides which one wins when both are
// present (cron gets priority for non-uniform schedules).
//
// `intervalMinutes` cap matches `add` (43_200 — 30 days). `cronExpr`
// length cap matches `add` (256). `agent` Zod-validates against the
// daemon's `agents.name` column shape (1..128).
const CostForecastInput = z
  .object({
    agent: z.string().min(1).max(128),
    intervalMinutes: z.number().int().min(1).max(43_200).optional(),
    cronExpr: z.string().min(1).max(256).optional(),
  })
  .refine(
    (v) => v.intervalMinutes !== undefined || v.cronExpr !== undefined,
    {
      message: "either intervalMinutes or cronExpr must be supplied",
      path: ["intervalMinutes"],
    },
  );

const COST_FORECAST_SAMPLE_CAP = 200;

function lookupScheduleForRuns(id: number): ScheduleRunsLookupRow | null {
  const db = getDb();
  const rows = db
    .select({
      id: schedules.id,
      name: schedules.name,
      agentName: schedules.agentName,
      prompt: schedules.prompt,
      channel: schedules.channel,
    })
    .from(schedules)
    .where(eq(schedules.id, id))
    .limit(1)
    .all();
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    id: row.id,
    name: row.name,
    agentName: row.agentName,
    prompt: row.prompt,
    channel: row.channel,
  };
}

function makeScheduleActionProcedure(action: ScheduleAction) {
  return publicProcedure
    .input(ScheduleActionInput)
    .mutation(async ({ input, ctx }): Promise<ScheduleMutationResult> => {
      if (!ctx.mcp) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "MCP client not configured on tRPC context",
        });
      }

      const auditBase = {
        resourceType: "schedule" as const,
        resourceId: String(input.id),
        userId: ctx.userId ?? null,
        req: ctx.req,
      };

      // Path A — server-side existence check. Mirrors `lookupLoop` in
      // `loops.cancel`: a clean NOT_FOUND for an id the dashboard can't
      // possibly have rendered (refresh-stale, manual URL entry)
      // without round-tripping the daemon. The lookup also gives us
      // the forensic columns (name, agentName) we record on every
      // audit row.
      const row = lookupSchedule(input.id);
      if (row === null) {
        appendAudit({
          ...auditBase,
          action: `schedule.${action}.error`,
          payload: {
            id: input.id,
            code: "NOT_FOUND",
          },
        });
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "schedule not found",
        });
      }

      const failurePayload: Record<string, unknown> = {
        id: input.id,
        name: row.name,
        agentName: row.agentName,
      };

      try {
        await ctx.mcp.call(
          SCHEDULE_TOOL_BY_ACTION[action],
          { name_or_id: String(input.id) },
          { timeoutMs: SCHEDULE_ADD_TIMEOUT_MS },
        );
      } catch (err) {
        appendAudit({
          ...auditBase,
          action: `schedule.${action}.error`,
          payload: {
            ...failurePayload,
            code: auditFailureCode(err),
          },
        });
        throw mapMcpErrorToTrpc(err);
      }

      appendAudit({
        ...auditBase,
        action: `schedule.${action}`,
        payload: {
          id: input.id,
          name: row.name,
          agentName: row.agentName,
        },
      });
      return { ok: true };
    });
}

export const schedulesRouter = router({
  // P3-T5 — list schedules with optional `agent` filter. Ordering: by
  // `nextRunAt` ASC NULLS LAST so the row most likely to fire next
  // surfaces at the top — the typical "what's about to run" question
  // the user opens this page to answer. Schedules with `nextRunAt=null`
  // (paused / never-fired) drop to the bottom.
  list: publicProcedure
    .input(ListInput)
    .query(({ input }): ScheduleListPage => {
      const db = getDb();
      const rows = db
        .select(LIST_DTO_SELECTION)
        .from(schedules)
        .where(input.agent !== undefined ? eq(schedules.agentName, input.agent) : undefined)
        // SQLite default ASC sort puts NULL first → wrap with the
        // standard "is null" companion ordering so populated values
        // come first. We can't express that in Drizzle's typed
        // `orderBy` directly without a raw expression, so we sort the
        // NULL-bucket separately client-side after pulling the page.
        .orderBy(desc(schedules.id))
        .all();

      const dtoRows = rows.map(rowToDto);
      // Custom sort: rows with a populated nextRunAt come first
      // (ascending — soonest fire first), then nulls (most-recently
      // created first — preserves the daemon's id-DESC default which
      // we already pulled).
      const withNext: ScheduleListRow[] = [];
      const withoutNext: ScheduleListRow[] = [];
      for (const row of dtoRows) {
        if (row.nextRunAt !== null && row.nextRunAt.length > 0) {
          withNext.push(row);
        } else {
          withoutNext.push(row);
        }
      }
      withNext.sort((a, b) => {
        // nextRunAt is non-null in this bucket — non-null assert is
        // safe because of the partition above.
        const aNext = a.nextRunAt!;
        const bNext = b.nextRunAt!;
        if (aNext < bNext) return -1;
        if (aNext > bNext) return 1;
        return 0;
      });
      return { items: [...withNext, ...withoutNext] };
    }),

  // P3-T6 — create a recurring schedule via the daemon's
  // `bridge_schedule_add` MCP tool. Same shape as Phase 2 T01
  // `tasks.dispatch` and P3-T3 `loops.start`: CSRF + rate-limit guards
  // run at the route handler; this procedure handles the audit row +
  // error mapping. We never insert into the `schedules` table directly
  // — the daemon owns schedule lifecycle.
  //
  // Audit shape (privacy precedent §c — prompt text NEVER echoed):
  //   success → action="schedule.add", resource_id=String(id),
  //             payload={ agentName, intervalMinutes, hasPrompt:true,
  //                       name?, cronExpr?, hasChannelChatId? }
  //   failure → action="schedule.add.error", resource_id=null,
  //             payload={ agentName, intervalMinutes, code,
  //                       name?, cronExpr? }
  //
  // The `prompt` text is `bridge_schedule_add`'s primary input — the
  // daemon writes it to `schedules.prompt` so the audit row stays a
  // minimal index, not a duplicate. Same rule we apply to
  // `tasks.dispatch.prompt` and `loops.start.goal`.
  //
  // `cronExpr` IS recorded in audit (short label, not opaque) so the
  // forensic trail captures the user's *intent* even though the daemon
  // currently only stores `intervalMinutes`. When daemon-side cron
  // support lands (filed against `claude-bridge`), no audit-shape
  // change is needed.
  add: publicProcedure
    .input(AddInput)
    .mutation(async ({ input, ctx }): Promise<ScheduleAddResult> => {
      if (!ctx.mcp) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "MCP client not configured on tRPC context",
        });
      }

      const params: {
        agent_name: string;
        prompt: string;
        interval_minutes: number;
        name?: string;
        chat_id?: string;
        user_id?: string;
      } = {
        agent_name: input.agentName,
        prompt: input.prompt,
        interval_minutes: input.intervalMinutes,
      };
      if (input.name !== undefined) params.name = input.name;
      if (input.channelChatId !== undefined) params.chat_id = input.channelChatId;
      if (ctx.userId !== undefined && ctx.userId !== null) params.user_id = ctx.userId;

      const auditBase = {
        resourceType: "schedule" as const,
        userId: ctx.userId ?? null,
        req: ctx.req,
      };

      // Audit failure-payload base — `prompt` is intentionally absent;
      // the dialog forwards it to the daemon but the audit only
      // records the metadata fields the user can reasonably want to
      // forensically replay later. `hasPrompt:true` is the privacy
      // sentinel that says "yes the daemon got a prompt value".
      const failurePayloadBase: Record<string, unknown> = {
        agentName: input.agentName,
        intervalMinutes: input.intervalMinutes,
      };
      if (input.name !== undefined) failurePayloadBase.name = input.name;
      if (input.cronExpr !== undefined) failurePayloadBase.cronExpr = input.cronExpr;

      let result: unknown;
      try {
        result = await ctx.mcp.call("bridge_schedule_add", params, {
          timeoutMs: SCHEDULE_ADD_TIMEOUT_MS,
        });
      } catch (err) {
        appendAudit({
          ...auditBase,
          action: "schedule.add.error",
          resourceId: null,
          payload: {
            ...failurePayloadBase,
            code: auditFailureCode(err),
          },
        });
        throw mapMcpErrorToTrpc(err);
      }

      const id = extractScheduleId(result);
      if (id === null) {
        appendAudit({
          ...auditBase,
          action: "schedule.add.error",
          resourceId: null,
          payload: {
            ...failurePayloadBase,
            code: "malformed_response",
          },
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "daemon returned malformed schedule add response",
        });
      }

      const successPayload: Record<string, unknown> = {
        agentName: input.agentName,
        intervalMinutes: input.intervalMinutes,
        hasPrompt: true,
      };
      if (input.name !== undefined) successPayload.name = input.name;
      if (input.cronExpr !== undefined) successPayload.cronExpr = input.cronExpr;
      if (input.channelChatId !== undefined) successPayload.hasChannelChatId = true;

      appendAudit({
        ...auditBase,
        action: "schedule.add",
        resourceId: String(id),
        payload: successPayload,
      });

      return { id };
    }),

  // P3-T7 — pause / resume / remove. Three sibling mutations that share
  // the same wire + audit + error shape. Each is built from
  // `buildScheduleActionProcedure(action)` so the privacy invariant
  // (prompt text never echoed) and the lookup-then-MCP-then-audit
  // ordering stay single-sourced. The daemon's
  // `bridge_schedule_{pause,resume,remove}` MCP tools all take a single
  // `name_or_id` string; we always pass `String(id)` (the row's
  // numeric id) so the daemon path is unambiguous.
  //
  // Audit shape:
  //   success → action=`schedule.<action>`, resource_id=String(id),
  //             payload={ id, name, agentName }
  //   not-found → action=`schedule.<action>.error`, resource_id=String(id),
  //               payload={ id, code: "NOT_FOUND" }
  //   mcp-error → action=`schedule.<action>.error`, resource_id=String(id),
  //               payload={ id, name, agentName, code }
  //
  // No optimistic UI on the server side — that's the client's job. The
  // procedure is server-confirmed (returns `{ ok: true }` only after
  // the daemon reply lands). Pause / resume + delete share the
  // confirmation contract; the dashboard's UX layer decides which
  // action ships through `runOptimistic` (P2-T10) and which doesn't.
  pause: makeScheduleActionProcedure("pause"),
  resume: makeScheduleActionProcedure("resume"),
  remove: makeScheduleActionProcedure("remove"),

  // P3-T8 — recent runs for a schedule. Heuristic join: the daemon
  // does NOT carry `schedule_id` on tasks (see scheduler.ts:80-88),
  // so we filter on the three columns it copies from the schedule
  // verbatim at dispatch time: session_id (resolved from the agent),
  // prompt, channel. A manually dispatched task with the same exact
  // prompt + agent + channel would surface here too — known
  // limitation, documented in T08-review.md. Collapses to a foreign-
  // key lookup if/when daemon gains `tasks.schedule_id` (Phase 4
  // entry note against `claude-bridge`).
  //
  // Read-only — no audit row (Phase 2 audit-scope decision: queries
  // are not audited). Same shape as `loops.list` / `tasks.list`.
  runs: publicProcedure
    .input(RunsInput)
    .query(({ input }): ScheduleRunsPage => {
      const schedule = lookupScheduleForRuns(input.id);
      if (schedule === null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "schedule not found",
        });
      }

      const db = getDb();

      // Resolve the agent's session_id. An "orphan" schedule (agent
      // row deleted out from under it) yields zero rows here — we
      // return an empty `items` array rather than 404 so the drawer
      // can render a clean "no runs yet" state with the agent name
      // still in the header.
      const agentRows = db
        .select({ sessionId: agents.sessionId })
        .from(agents)
        .where(eq(agents.name, schedule.agentName))
        .limit(1)
        .all();
      if (agentRows.length === 0) {
        return {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          agentName: schedule.agentName,
          items: [],
        };
      }
      const sessionId = agentRows[0]!.sessionId;

      // Heuristic filter — see procedure header. `channel` is
      // nullable on the schedules schema; treat NULL as "cli"
      // (the daemon's default) so legacy rows match the dispatched
      // tasks the daemon would have written under the same default.
      const channel = schedule.channel ?? "cli";
      const taskRows = db
        .select(SCHEDULE_RUN_DTO_SELECTION)
        .from(tasks)
        .where(
          and(
            eq(tasks.sessionId, sessionId),
            eq(tasks.prompt, schedule.prompt),
            eq(tasks.channel, channel),
          ),
        )
        .orderBy(desc(tasks.id))
        .limit(input.limit)
        .all();

      const items: ScheduleRunRow[] = taskRows.map((row) => ({
        id: row.id,
        status: row.status,
        costUsd: row.costUsd,
        durationMs: row.durationMs,
        channel: row.channel,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
      }));

      return {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        agentName: schedule.agentName,
        items,
      };
    }),

  // P3-T9 — cost forecast for a candidate schedule. Read-only: pulls
  // the agent's recent cost-bearing task rows and hands the array +
  // cadence to `forecastSchedule` (single source of truth for the
  // math). The schedule-create dialog calls this every time the user
  // changes agent / cadence and renders the resulting wire envelope
  // under the cron picker.
  //
  // Input contract: at least one of `intervalMinutes` / `cronExpr`
  // must be supplied (Zod refine). When both are supplied, the helper
  // prefers cron (more accurate for non-uniform schedules); when
  // cron is invalid / un-parseable it silently falls back to the
  // interval. An entirely-unresolved cadence (cron malformed +
  // interval missing) surfaces `cadenceUnresolved: true` on the wire
  // — the dialog hides the dollar block and the math still produces
  // useful sample-pool diagnostics.
  //
  // Sample pool: 200 most-recent cost-bearing tasks for the agent
  // (`cost_usd > 0`, ordered id DESC, no date filter — see review).
  // Unknown agent → empty pool → `insufficientHistory: true` but
  // `runsPerMonth` still computed (useful "what if this agent
  // existed?" diagnostic).
  //
  // No audit, no MCP, no CSRF — read-only query (Phase 2 audit-scope
  // decision: queries are not audited).
  costForecast: publicProcedure
    .input(CostForecastInput)
    .query(({ input }): ScheduleCostForecast => {
      const db = getDb();

      // Resolve the agent's session_id. Unknown agent → empty sample
      // pool; we still compute `runsPerMonth` so the caller can render
      // "this cadence fires N times per month" without history.
      const agentRows = db
        .select({ sessionId: agents.sessionId })
        .from(agents)
        .where(eq(agents.name, input.agent))
        .limit(1)
        .all();

      let samples: number[] = [];
      if (agentRows.length > 0) {
        const sessionId = agentRows[0]!.sessionId;
        // Drizzle expression: `cost_usd > 0`. Drops both NULL (via
        // `isNotNull`) and zero-cost rows in one pass; the daemon
        // writes `cost_usd = 0` for tasks that never billed (early
        // exit / validation failure), and including those would skew
        // the median toward 0 (under-estimate).
        const rows = db
          .select({ costUsd: tasks.costUsd })
          .from(tasks)
          .where(
            and(
              eq(tasks.sessionId, sessionId),
              isNotNull(tasks.costUsd),
              gt(tasks.costUsd, 0),
            ),
          )
          .orderBy(desc(tasks.id))
          .limit(COST_FORECAST_SAMPLE_CAP)
          .all();
        samples = rows
          .map((r) => r.costUsd)
          .filter((v): v is number => v !== null);
      }

      // `now` capture is internal to the procedure — the cron-mode
      // cadence count anchors on it but interval-mode is time-
      // independent. Tests for cron-mode behavior live in
      // `tests/lib/cost-forecast.test.ts` where `now` is injectable;
      // the router test pins interval-mode + zero-sample-pool paths
      // against deterministic seed data.
      const forecast = forecastSchedule({
        samples,
        intervalMinutes: input.intervalMinutes ?? null,
        cronExpr: input.cronExpr ?? null,
        now: new Date(),
      });

      return forecast;
    }),
});
