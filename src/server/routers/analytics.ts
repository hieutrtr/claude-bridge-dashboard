// T09 — analytics.* router. Phase 1 ships the two read-only query
// procedures from v1 ARCHITECTURE.md §4.5: `dailyCost` and `summary`.
// `budget`, `setBudget`, `export` are mutations — Phase 2.
//
// Aggregates run against the raw `tasks` table (not the v1 `v_cost_daily`
// view): the daemon's bridge.db may not have the view created and the
// dashboard cannot run DDL. Same filter as the view definition —
// `status = 'done' AND cost_usd IS NOT NULL` — so output matches the
// `bridge cost` CLI ± floating-point noise.

import { z } from "zod";
import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";

import { authedProcedure, router } from "../trpc";
import { getDb } from "../db";
import { agents, tasks, users } from "../../db/schema";
import type {
  CostByUserPayload,
  CostByUserRow,
  CostSummary,
  DailyCostPoint,
} from "../dto";

const DailyCostInput = z.object({
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  groupBy: z.enum(["agent", "channel", "model"]).optional(),
});

const SummaryInput = z.object({
  window: z.enum(["24h", "7d", "30d"]),
});

const CostByUserInput = z.object({
  window: z.enum(["24h", "7d", "30d"]),
});

// Map the public window literal to the SQLite `datetime('now', '<modifier>')`
// modifier string. Centralised so the router and DTO stay aligned.
const WINDOW_MODIFIERS: Record<"24h" | "7d" | "30d", string> = {
  "24h": "-24 hours",
  "7d": "-7 days",
  "30d": "-30 days",
};

// Group-by → join column. agent goes through the agents leftJoin (so a
// task whose agents row was deleted surfaces as `key: null`); channel and
// model project from `tasks` directly.
function groupKeyExpr(groupBy: "agent" | "channel" | "model" | undefined) {
  if (groupBy === "agent") return agents.name;
  if (groupBy === "channel") return tasks.channel;
  if (groupBy === "model") return tasks.model;
  return null;
}

export const analyticsRouter = router({
  dailyCost: authedProcedure
    .input(DailyCostInput)
    .query(({ input }): DailyCostPoint[] => {
      const db = getDb();

      const dayExpr = sql<string>`date(${tasks.completedAt})`;
      const costExpr = sql<number>`coalesce(sum(${tasks.costUsd}), 0)`;
      const countExpr = sql<number>`count(*)`;

      const filters = [
        eq(tasks.status, "done"),
        isNotNull(tasks.costUsd),
        isNotNull(tasks.completedAt),
      ];

      if (input.since !== undefined) {
        filters.push(gte(tasks.completedAt, input.since));
      } else if (input.until === undefined) {
        // Default 30-day window when neither bound supplied; matches the
        // page's "30-day spend" headline. Compared against the raw text
        // representation of completed_at (SQLite stores datetime() as
        // 'YYYY-MM-DD HH:MM:SS' — same lexical sort as text).
        filters.push(gte(tasks.completedAt, sql`datetime('now', '-30 days')`));
      }
      if (input.until !== undefined) {
        filters.push(lte(tasks.completedAt, input.until));
      }

      const keyExpr = groupKeyExpr(input.groupBy);

      if (keyExpr === null) {
        const rows = db
          .select({
            day: dayExpr,
            costUsd: costExpr,
            taskCount: countExpr,
          })
          .from(tasks)
          .where(and(...filters))
          .groupBy(dayExpr)
          .orderBy(dayExpr)
          .all();
        return rows.map((r) => ({
          day: r.day,
          key: null,
          costUsd: Number(r.costUsd ?? 0),
          taskCount: Number(r.taskCount ?? 0),
        }));
      }

      const rows = db
        .select({
          day: dayExpr,
          key: keyExpr,
          costUsd: costExpr,
          taskCount: countExpr,
        })
        .from(tasks)
        .leftJoin(agents, eq(tasks.sessionId, agents.sessionId))
        .where(and(...filters))
        .groupBy(dayExpr, keyExpr)
        .orderBy(dayExpr, keyExpr)
        .all();

      return rows.map((r) => ({
        day: r.day,
        key: r.key ?? null,
        costUsd: Number(r.costUsd ?? 0),
        taskCount: Number(r.taskCount ?? 0),
      }));
    }),

  summary: authedProcedure
    .input(SummaryInput)
    .query(({ input }): CostSummary => {
      const db = getDb();

      const modifier = WINDOW_MODIFIERS[input.window];
      const sinceExpr = sql<string>`datetime('now', ${modifier})`;

      // Echo the resolved `since` so the page can render
      // "since YYYY-MM-DD" without re-computing client-side.
      const sinceRow = db
        .select({ since: sinceExpr })
        .from(sql`(SELECT 1)`)
        .all()[0];
      const since = sinceRow?.since ?? "";

      const baseFilters = [
        eq(tasks.status, "done"),
        isNotNull(tasks.costUsd),
        isNotNull(tasks.completedAt),
        gte(tasks.completedAt, sinceExpr),
      ];

      const totalsRow = db
        .select({
          totalCostUsd: sql<number>`coalesce(sum(${tasks.costUsd}), 0)`,
          totalTasks: sql<number>`count(*)`,
        })
        .from(tasks)
        .where(and(...baseFilters))
        .all()[0];

      const totalCostUsd = Number(totalsRow?.totalCostUsd ?? 0);
      const totalTasks = Number(totalsRow?.totalTasks ?? 0);
      const avgCostPerTask = totalTasks > 0 ? totalCostUsd / totalTasks : 0;

      const topAgentsRows = db
        .select({
          agentName: agents.name,
          costUsd: sql<number>`coalesce(sum(${tasks.costUsd}), 0)`.as("cost_sum"),
          taskCount: sql<number>`count(*)`.as("task_count"),
        })
        .from(tasks)
        .leftJoin(agents, eq(tasks.sessionId, agents.sessionId))
        .where(and(...baseFilters))
        .groupBy(agents.name)
        .orderBy(desc(sql`cost_sum`))
        .limit(5)
        .all();

      const topModelsRows = db
        .select({
          model: tasks.model,
          costUsd: sql<number>`coalesce(sum(${tasks.costUsd}), 0)`.as("cost_sum"),
          taskCount: sql<number>`count(*)`.as("task_count"),
        })
        .from(tasks)
        .where(and(...baseFilters))
        .groupBy(tasks.model)
        .orderBy(desc(sql`cost_sum`))
        .limit(5)
        .all();

      return {
        window: input.window,
        since,
        totalCostUsd,
        totalTasks,
        avgCostPerTask,
        topAgents: topAgentsRows.map((r) => ({
          agentName: r.agentName ?? null,
          costUsd: Number(r.costUsd ?? 0),
          taskCount: Number(r.taskCount ?? 0),
        })),
        topModels: topModelsRows.map((r) => ({
          model: r.model ?? null,
          costUsd: Number(r.costUsd ?? 0),
          taskCount: Number(r.taskCount ?? 0),
        })),
      };
    }),

  // P4-T04 — `analytics.costByUser`. Read-only leaderboard for the
  // `/cost` "By user" tab. Owner branch returns one row per active
  // user with spend in the window plus a synthetic `(unattributed)`
  // bucket folding `tasks.user_id IS NULL` rows + tasks pointing at a
  // revoked / unknown user. Member branch filters strictly to the
  // caller's own user_id (zero-fills when no spend).
  //
  // Predicate matches `analytics.summary` so the per-user totals
  // cross-check against `summary.totalCostUsd` for the same window —
  // the load-bearing acceptance criterion (T04 task file).
  costByUser: authedProcedure
    .input(CostByUserInput)
    .query(({ ctx, input }): CostByUserPayload => {
      const db = getDb();
      const caller = ctx.user;

      const modifier = WINDOW_MODIFIERS[input.window];
      const sinceExpr = sql<string>`datetime('now', ${modifier})`;

      const sinceRow = db
        .select({ since: sinceExpr })
        .from(sql`(SELECT 1)`)
        .all()[0];
      const since = sinceRow?.since ?? "";

      const baseFilters = [
        eq(tasks.status, "done"),
        isNotNull(tasks.costUsd),
        isNotNull(tasks.completedAt),
        gte(tasks.completedAt, sinceExpr),
      ];

      if (caller.role === "member") {
        const ownFilters = [...baseFilters, eq(tasks.userId, caller.id)];
        const totalsRow = db
          .select({
            totalCostUsd: sql<number>`coalesce(sum(${tasks.costUsd}), 0)`,
            totalTasks: sql<number>`count(*)`,
          })
          .from(tasks)
          .where(and(...ownFilters))
          .all()[0];

        const totalCostUsd = Number(totalsRow?.totalCostUsd ?? 0);
        const totalTasks = Number(totalsRow?.totalTasks ?? 0);

        // Member zero-fill: surface the caller's identity even when
        // they have no spend in the window so the UI can render the
        // "Your spend this window: $0.00" copy without an empty state.
        const selfRow: CostByUserRow = {
          userId: caller.id,
          email: caller.email,
          costUsd: totalCostUsd,
          taskCount: totalTasks,
          shareOfTotal: totalTasks > 0 ? 1 : 0,
        };

        return {
          window: input.window,
          since,
          rows: totalTasks > 0 ? [selfRow] : [],
          totalCostUsd,
          totalTasks,
          callerRole: "member",
          selfRow,
        };
      }

      // Owner branch — total + per-user breakdown.
      const totalsRow = db
        .select({
          totalCostUsd: sql<number>`coalesce(sum(${tasks.costUsd}), 0)`,
          totalTasks: sql<number>`count(*)`,
        })
        .from(tasks)
        .where(and(...baseFilters))
        .all()[0];
      const totalCostUsd = Number(totalsRow?.totalCostUsd ?? 0);
      const totalTasks = Number(totalsRow?.totalTasks ?? 0);

      // LEFT JOIN against `users WHERE revoked_at IS NULL`. A revoked
      // user, an unknown id, and a NULL user_id all produce a NULL
      // join key — they collapse into a single `(unattributed)` bucket
      // grouped on `users.id IS NULL`. Privacy: keeping these three
      // branches indistinguishable prevents the cost view from leaking
      // revocation status (precedent §c).
      const grouped = db
        .select({
          userId: users.id,
          email: users.email,
          costUsd: sql<number>`coalesce(sum(${tasks.costUsd}), 0)`,
          taskCount: sql<number>`count(*)`,
        })
        .from(tasks)
        .leftJoin(
          users,
          and(eq(tasks.userId, users.id), sql`${users.revokedAt} IS NULL`),
        )
        .where(and(...baseFilters))
        .groupBy(users.id, users.email)
        .all();

      const rows: CostByUserRow[] = grouped.map((r) => {
        const cost = Number(r.costUsd ?? 0);
        return {
          userId: r.userId ?? null,
          email: r.email ?? null,
          costUsd: cost,
          taskCount: Number(r.taskCount ?? 0),
          shareOfTotal: totalCostUsd > 0 ? cost / totalCostUsd : 0,
        };
      });

      // Sort: costUsd DESC, then email ASC (NULLS LAST so the
      // unattributed bucket drops to the bottom on ties), then userId
      // ASC for total determinism across runs.
      rows.sort((a, b) => {
        if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
        if (a.email === null && b.email !== null) return 1;
        if (a.email !== null && b.email === null) return -1;
        if (a.email !== null && b.email !== null) {
          if (a.email < b.email) return -1;
          if (a.email > b.email) return 1;
        }
        const ai = a.userId ?? "";
        const bi = b.userId ?? "";
        if (ai < bi) return -1;
        if (ai > bi) return 1;
        return 0;
      });

      return {
        window: input.window,
        since,
        rows,
        totalCostUsd,
        totalTasks,
        callerRole: "owner",
        selfRow: null,
      };
    }),
});
