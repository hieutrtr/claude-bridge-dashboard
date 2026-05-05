# P1-T09 — Cost analytics page — Self-Review

> Spec: `T09-cost-analytics.md`. Iter 10/17.

## Files changed / added

**New:**
- `src/server/routers/analytics.ts` — `analyticsRouter` with two query
  procedures: `dailyCost` (per-day or per-(day,key) aggregate over
  `tasks.cost_usd` filtered to `status='done' AND cost_usd IS NOT NULL`)
  and `summary` (window totals + topAgents + topModels for the cost
  page header and pie/bar charts).
- `src/components/cost-charts.tsx` — `"use client"` leaf wrapping the
  three Recharts primitives (`LineChart` for daily spend,
  `PieChart` for top agents, `BarChart` for top models). Pure render
  given props; no state/effects.
- `tests/server/analytics-router.test.ts` — 16 tests, 51 expects
  covering both procedures (empty inputs, status/cost filters,
  default 30-day window, since/until bounds, all three groupBy modes,
  numeric output, ordering, top-5 cap, null model/agent surfaces,
  avgCostPerTask floating-point invariant).
- `tests/app/cost-page.test.ts` — 4 page-level smoke tests (default
  export type, no mutation handlers, empty-state copy under 0 done
  tasks, KPI numbers under seeded done tasks).
- `docs/tasks/phase-1/T09-cost-analytics.md` — task spec.
- `docs/tasks/phase-1/T09-review.md` — this file.

**Modified:**
- `src/server/dto.ts` — added `DailyCostPoint`, `CostSummary`,
  `CostSummaryAgentRow`, `CostSummaryModelRow` types. Documents the
  `topModels` extension vs the v1 spec.
- `src/server/routers/_app.ts` — registered `analyticsRouter` under
  `appRouter.analytics`.
- `app/cost/page.tsx` — replaced the placeholder with a server-rendered
  page that fetches summary + daily series in parallel, renders 3 KPI
  cards + (chart wrapper OR empty-state branch).
- `package.json` / `bun.lock` — added `recharts@^2.15.0` to
  `dependencies` (React 19 compatible).
- `docs/tasks/phase-1/INDEX.md` — checkbox + status line bump.

## Self-review checklist

- [x] **Tests cover happy + 1 edge case** — happy: aggregate by day,
  groupBy=agent fan-out, top-5 ordering, avg arithmetic. Edge: empty
  table → `[]`/zeros; status≠'done' filtered; cost_usd NULL filtered;
  default 30-day window excludes 60-day-old rows; since/until
  inclusive bounds; null model/agent surface as `null` not dropped;
  topAgents capped at 5 with 7 seeded; avgCostPerTask = 0 (not NaN)
  on empty input. Page edge: empty-state branch renders instead of
  charts when totalTasks === 0.
- [x] **Not over-engineered** —
  - Two query procedures (matches v1 §4.5 spec). `topModels` is the
    only addition vs spec; documented in DTO comment as one less
    tRPC call per page render.
  - No shadcn chart wrapper (raw Recharts is sufficient for 3 charts).
  - No date-range picker (30-day window hard-coded — Phase 2 polish).
  - No CSV export (Phase 2 mutation).
  - No `v_cost_daily` view dependency — query the raw `tasks` table
    directly so the dashboard works against any compatible
    `bridge.db` whether or not the view exists.
- [x] **ARCHITECTURE v2 picks honoured** —
  - Next.js App Router server component (`app/cost/page.tsx`) calling
    tRPC via `appRouter.createCaller({})` — same pattern as
    T03/T04/T05/T06/T07.
  - Drizzle 0.40 `select().from().leftJoin().where().groupBy().orderBy()`
    pipeline; aggregates expressed via `sql<T>` template literals.
  - bun:sqlite via the existing `getDb()` handle — no new DB stack.
  - Recharts (v1 ARCH §2 stack pick) — declarative React components,
    tree-shakable, React 19 compat.
  - Tailwind v4 design tokens reused (`hsl(var(--border))`,
    `hsl(var(--card))`, `hsl(var(--muted-foreground))`).
- [x] **No secret leak** — payload only carries
  `day / key / costUsd / taskCount` and aggregate KPIs. No file paths,
  no session ids, no agent project_dir, no JWT data.
- [x] **Read-only: NO mutation/dispatch call** —
  - `src/server/routers/analytics.ts`: only `publicProcedure.query`
    procedures; no `.mutation(`, no `.insert(`, no `.update(`,
    no `.delete(`. Verified via
    `grep "\.insert\|\.update\|\.delete\|mutation" src/server/routers/analytics.ts`
    → only one match for the literal word "mutations" in a comment.
  - `app/cost/page.tsx`: only consumes tRPC query procedures. The
    word "dispatch" appears in user-facing copy
    ("run a task with `bridge dispatch`") and in a comment — not
    a function call.
  - `src/components/cost-charts.tsx`: pure render, no IO. `grep` for
    insert/update/delete → no matches.
  - Page test asserts no POST/PUT/PATCH/DELETE export, mirroring
    the T08 read-only guard.

## Acceptance bullets vs spec

1. ✅ `dailyCost({ since })` over 3-day fixture returns 3 day rows with
   summed `costUsd` (test "aggregates per-day totals (no groupBy) in
   day ASC order").
2. ✅ `dailyCost({ since, groupBy: 'agent' })` fans out one row per
   (day, agentName) (test "groupBy: 'agent' fans out one row per
   (day, agentName)").
3. ✅ `dailyCost` skips `status != 'done'` AND `cost_usd IS NULL`
   (two dedicated tests).
4. ✅ `summary({ window: '7d' })` over a 3-task fixture totals
   correctly and reports `avgCostPerTask = total/count`; emits 0
   for empty input (test
   "avgCostPerTask is total/count with no NaN on empty input").
5. ✅ `summary` orders `topAgents` and `topModels` by `costUsd DESC`
   capped at 5 (test "topAgents ordered by costUsd DESC and capped
   at 5", "topModels ordered DESC and surfaces null model").
6. ✅ `/cost` page renders the three KPI numbers (test "renders KPI
   numbers from the analytics summary when seeded" asserts
   "Total spend", "$2.00", ">2<", "$1.00").
7. ✅ Read-only guard (test "does NOT export POST/PUT/PATCH/DELETE
   handlers" + grep verification — see checklist above).
8. ✅ `bun test`: 159 → 179 (+20 new); `bun run typecheck` clean.

## Issues found / decisions

- **`topModels` extension to `summary`.** v1 ARCH §4.5 lists only
  `topAgents`. Adding `topModels` lets the page get all chart data
  from one `summary` call instead of three calls. Decision: ship
  the extension. Documented in `dto.ts` and the spec.
- **Default 30-day window.** When neither `since` nor `until` is
  passed, `dailyCost` clips to `datetime('now', '-30 days')` so the
  page never accidentally scans the entire history. The bound is
  applied as a `gte(tasks.completedAt, sql\`datetime('now', '-30 days')\`)`
  filter. Edge case noted in spec — anybody calling `dailyCost({})`
  with the intent of "give me everything" needs to pass an explicit
  `since`.
- **Recharts SSR.** The chart leaf is `"use client"`. The page test
  exercises only the empty-state branch (no chart rendered) — the
  populated test seeds done tasks but `renderToStaticMarkup` walks
  the React tree without running effects, so `ResponsiveContainer`'s
  `ResizeObserver` mount never executes. Confirmed: 4/4 page tests
  pass.
- **Numeric coercion at the wire.** SQLite returns aggregate columns
  as either number or BigInt depending on driver; Drizzle wraps via
  `sql<T>` but doesn't coerce at runtime. The router explicitly wraps
  every aggregate result in `Number(...)` so the wire payload never
  carries a BigInt or string. Verified by the
  "returns numeric costUsd / integer taskCount" test.
- **Orphan tasks.** A `tasks` row whose `session_id` no longer
  matches any `agents` row surfaces in `topAgents` as
  `agentName: null` (preserves the spend total). Test
  "topAgents preserves null agentName for orphan tasks" pins this
  behaviour. The chart leaf renders `(unknown)` for that bucket.
- **`v_cost_daily` view not used.** The view's grouping is
  `(day, session_id)` — wrong shape for our chart (we want
  `(day [, agentName | channel | model])`). The router computes the
  same aggregate from raw `tasks` directly, so the dashboard works
  against any `bridge.db` whether or not the view was created.
- **No date-range picker.** The page hard-codes a 30-day window. If
  Phase 2 users want 7d / 90d / custom, the procedure inputs already
  support arbitrary `since`/`until` — just need a UI control. Flagged
  as a polish task.

## Test summary

```
$ bun test
 179 pass
   0 fail
 541 expect() calls
Ran 179 tests across 17 files. [671 ms]
```

Up from 159 → 179 (+20 new): 16 in `tests/server/analytics-router.test.ts`,
4 in `tests/app/cost-page.test.ts`.

`bun run typecheck` clean.

## Manual browser verification checklist (PHASE-BROWSER-TEST)

- [ ] Navigate to `/cost` — page renders within ~200 ms (FCP budget
      §11). KPI cards show real numbers from `bridge.db`.
- [ ] Numbers cross-check against `bridge cost --window 30d` CLI
      output ± $0.01.
- [ ] Daily-spend line covers ~30 day x-axis with at least one data
      point (assuming the daemon has any done tasks in the last 30d).
- [ ] Pie chart legend lists up to 5 agents; bar chart shows up to 5
      models.
- [ ] Empty `bridge.db` (or one with no done tasks) renders the
      "No completed tasks yet" copy instead of charts.
