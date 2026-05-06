// P3-T5 — `schedules.*` router. Phase 3 entry point for the recurring-
// schedule vertical: this commit only ships `list` (read-only over the
// vendored `schedules` table). The mutation surface
// (`add`/`pause`/`resume`/`remove`) lands in T6 + T7 and routes through
// daemon MCP tools (`bridge_schedule_*`) per Phase 3 INDEX invariant.
//
// Wire shape — see `ScheduleListRow` in `src/server/dto.ts` for the
// curated column set. No `cursor` pagination this iter: schedules are
// finite (humans manage them by hand; the median deployment will
// have < 50). If a deployment grows past the no-virtualization
// threshold we add cursor pagination as a follow-up — same shape as
// `loops.list` (started_at-DESC keyset).
//
// Read-only — no MCP, no audit (queries are not audited per Phase 2
// scope decision). The page polls every N seconds for live updates.

import { z } from "zod";
import { desc, eq } from "drizzle-orm";

import { publicProcedure, router } from "../trpc";
import { getDb } from "../db";
import { schedules } from "../../db/schema";
import type { ScheduleListPage, ScheduleListRow } from "../dto";

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
});
