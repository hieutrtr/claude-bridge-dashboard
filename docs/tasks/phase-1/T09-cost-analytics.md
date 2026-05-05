# P1-T09 — Cost analytics page (read-only)

> Iter 10/17. Dependencies: T05 (`tasks.list` query helpers — same SQL surface),
> T01 (sidebar `/cost` link). Read-only invariant: NO mutation procedures.

## Source plan

- v2 IMPLEMENTATION-PLAN §Phase 1 (re-points to v1).
- v1 IMPLEMENTATION-PLAN line 87:
  > **P1-T9 — Cost analytics page (read-only)** · 3 chart: spend theo ngày
  > (30 ngày), spend theo agent (pie), spend theo model (bar). Recharts.

## Architecture references (read first)

- v1 ARCHITECTURE.md §3 — data model: `tasks.cost_usd`, `tasks.completed_at`,
  `agents.name`/`session_id`, plus the `v_cost_daily` view sketch
  (`SELECT date(completed_at), session_id, SUM(cost_usd), COUNT(*) FROM tasks
   WHERE status = 'done' AND cost_usd IS NOT NULL GROUP BY day, session_id`).
- v1 ARCHITECTURE.md §4.5 `analytics.*` — surface:
  ```
  analytics.dailyCost({ since, until, groupBy: 'agent' | 'channel' | 'model' })
  analytics.summary({ window: '24h' | '7d' | '30d' })
  // → { totalCostUsd, totalTasks, avgCostPerTask, topAgents }
  analytics.budget()                                 ← Phase 2 (mutation pair)
  analytics.setBudget(...)                           ← Phase 2 (mutation)
  analytics.export({ format, since, until })         ← Phase 2 (mutation)
  ```
- v1 ARCHITECTURE.md §11 perf budgets: chart render < 250 ms server-side, DB
  query p95 < 50 ms, FCP `/cost` < 200 ms.
- v1 ARCHITECTURE.md §10 security — read-only query, no SSR-side user input
  passed to `sql` template (all params bound).
- INDEX.md note: `v_cost_daily` view may not exist on the daemon's `bridge.db`
  — dashboard cannot run DDL. **Decision: query raw `tasks` table; never
  reference the view.** Same aggregate, no DDL dependency.

## Scope

### In scope (this task)

1. `analytics.dailyCost({ since?, until?, groupBy?: 'agent' | 'channel' |
   'model' })` query procedure on a new `analyticsRouter`. Returns per-day
   aggregate of cost over the window:
   - Without groupBy → `{ day: 'YYYY-MM-DD', key: null, costUsd, taskCount }[]`
   - With groupBy   → `{ day, key: <agent | channel | model>, costUsd,
     taskCount }[]` (one row per (day, key) bucket)
   - Filters `status = 'done'` and `cost_usd IS NOT NULL` (matches the v1 view
     definition — failed/queued tasks don't contribute).
   - `since` / `until` accept ISO date or full timestamp strings; compared as
     text against `tasks.completed_at`.
   - Default window when both bounds omitted: last 30 days.
   - Order: `day ASC, key ASC` so the chart can render without a client sort.

2. `analytics.summary({ window: '24h' | '7d' | '30d' })` query. Returns:
   ```ts
   {
     window: '24h' | '7d' | '30d',
     since: string,           // ISO bound used (echoed for the page header)
     totalCostUsd: number,    // 0 when no done tasks in window
     totalTasks: number,
     avgCostPerTask: number,  // 0 when totalTasks === 0 (no NaN on the wire)
     topAgents: { agentName: string | null, costUsd, taskCount }[],  // top 5 desc
     topModels: { model: string | null, costUsd, taskCount }[],      // top 5 desc
   }
   ```
   `topModels` extends the v1 spec (which lists only `topAgents`) so the
   "spend per model" bar chart can read its data straight from `summary`
   instead of a third procedure call.

3. `/cost` page (`app/cost/page.tsx`):
   - Server component. Calls `analytics.summary({ window: '30d' })` +
     `analytics.dailyCost({ since: <30d ago> })` via `appRouter.createCaller`.
   - Header section: total spend, total tasks, avg / task — three KPI cards
     (server-rendered text, no chart deps).
   - Chart section (client component, `"use client"` at the leaf):
     - Daily-spend line (30 days) — Recharts `<LineChart>` with one
       `<Line>` over the `dailyCost` series.
     - Spend-per-agent pie — Recharts `<PieChart>` over `summary.topAgents`.
     - Spend-per-model bar — Recharts `<BarChart>` over `summary.topModels`.
   - Empty state: when `totalTasks === 0` render "No completed tasks yet"
     instead of the charts (T11 polishes the empty/loading variants).

4. Recharts dependency: add `recharts@^2.15.0` (React 19 compat) to
   `package.json` `dependencies`. shadcn chart wrapper (v1 §2 stack pick)
   is not required for the three Phase 1 charts — Recharts primitives are
   sufficient and avoid pulling another transitive dep.

5. Test coverage:
   - `tests/server/analytics-router.test.ts` — fresh test file mirroring the
     `tasks-router.test.ts` pattern (in-memory SQLite via `BRIDGE_DB`).
     ≥ 14 cases across `dailyCost` + `summary`.
   - `tests/app/cost-page.test.ts` — smoke test that the page module
     compiles, exports a default async component, and renders headings
     when given seeded DB rows. Chart rendering itself is **not asserted**
     (Recharts pulls a `ResizeObserver` shim; not worth the test infra in
     Phase 1).

### Out of scope (deferred)

- `analytics.budget()` / `analytics.setBudget()` / `analytics.export()` —
  mutations and budget tracking belong to **Phase 2** (Architecture §4.5).
- shadcn chart wrapper — defer until Phase 2 if cost dashboards grow more
  complex.
- Date-range picker UI (currently hard-coded 30-day window) — Phase 2 if
  users ask for 7d / 90d / custom toggles.
- CSV download — covered by `analytics.export` (Phase 2).
- Cost forecast (P3-T9 in v1 plan) — Phase 3.

## Acceptance

1. `analytics.dailyCost({ since: '2026-04-05' })` over a fixture of done
   tasks across 3 distinct days returns 3 rows (one per day), with
   `costUsd` summing the matching `tasks.cost_usd`.
2. `analytics.dailyCost({ since: '2026-04-05', groupBy: 'agent' })` returns
   one row per (day, agentName) — verifies fan-out by agent.
3. `analytics.dailyCost` skips rows where `status != 'done'` or
   `cost_usd IS NULL` (matches v1 `v_cost_daily` semantics).
4. `analytics.summary({ window: '7d' })` over a fixture with 3 done tasks
   in the last 7 days totals `costUsd` correctly and reports
   `avgCostPerTask = totalCostUsd / totalTasks` (no NaN when 0 tasks).
5. `analytics.summary` orders `topAgents` and `topModels` by `costUsd DESC`
   and caps at 5 entries.
6. `/cost` page renders the three KPI numbers from `summary` (text
   assertable in the smoke test).
7. `/cost` page issues only `analytics.*` query calls — grep confirms no
   `mutation`, no `dispatch`, no DB write inside the page, the router, or
   the chart leaf component.
8. `bun test` passes — current 159 + new tests; `bun run typecheck` clean.

## TDD plan

### Red 1 — `dailyCost` (`tests/server/analytics-router.test.ts`)

Cases:
1. Returns `[]` when no tasks rows exist.
2. Returns `[]` when all tasks are `status != 'done'` (filters out queued /
   running / failed).
3. Returns `[]` when all `cost_usd` are NULL.
4. Aggregates per-day total when no `groupBy`, in `day ASC` order.
5. Applies the default 30-day window when `since` omitted (seeded older
   row excluded).
6. `since` / `until` bounds clip the window inclusively.
7. `groupBy: 'agent'` produces one row per (day, agentName); session_id →
   agent.name resolution honours the leftJoin.
8. `groupBy: 'channel'` keys by `tasks.channel` (including `null` channel
   tasks — surfaced as `key: null`).
9. `groupBy: 'model'` keys by `tasks.model` (NULL model surfaces as
   `key: null`).
10. Numeric output: `costUsd` is a JS number, never a string; `taskCount`
    is an integer.

### Red 2 — `summary`

11. Returns zeros (`totalCostUsd: 0`, `totalTasks: 0`, `avgCostPerTask: 0`)
    when no tasks.
12. `window: '24h'` excludes a task done 25h ago.
13. `topAgents` ordered by `costUsd DESC`, capped at 5.
14. `topAgents` includes a `null` agent entry when the joined agents row
    is missing (orphan task) — same shape, name `null`.
15. `topModels` ordered DESC, capped at 5; `null` model surfaces as
    `model: null`.
16. `avgCostPerTask` returns the arithmetic mean (cost / count), with
    floating-point tolerance (`Math.abs(diff) < 1e-9`).

### Red 3 — `/cost` page smoke (`tests/app/cost-page.test.ts`)

17. Page module exports a default async function (Next.js App Router
    convention).
18. Page renders KPI heading text ("Total spend", "Tasks", "Avg / task")
    over a seeded DB.
19. When `totalTasks === 0`, page renders the "No completed tasks yet"
    empty-state copy and skips the chart wrapper.
20. Page does NOT export a POST/PUT/PATCH/DELETE handler (it's a page,
    not a route; this assertion mirrors the T08 read-only guard).

### Green

- New file `src/server/routers/analytics.ts` with `dailyCost` + `summary`.
- New DTO types in `src/server/dto.ts`: `DailyCostPoint`, `CostSummary`.
- Wire `analyticsRouter` into `src/server/routers/_app.ts`.
- New leaf `src/components/cost-charts.tsx` (`"use client"`) — wraps
  Recharts primitives. Pure render given props.
- Rewrite `app/cost/page.tsx` from the placeholder to a server-rendered
  page.
- `package.json` adds `recharts` to `dependencies`.

### Refactor

If aggregate SQL helpers prove repetitive (sum/count select pattern), pull
them into a `src/server/analytics-sql.ts` helper. Otherwise inline.

## Notes / open questions

- **completed_at format.** SQLite stores numeric defaults as ISO-ish text
  ("YYYY-MM-DD HH:MM:SS"). `date(completed_at)` extracts the day cleanly.
  The fixture uses the same format, so text comparison is total.
- **`v_cost_daily` view.** Not used. The view's grouping key is
  `(day, session_id)`; we group by `(day [, agent.name | channel | model])`
  for the chart, so the view is the wrong shape anyway.
- **Channel / model NULL.** Real rows commonly have
  `channel = 'cli'` (default), but `model` is sometimes NULL when the
  daemon didn't record it. Both groupings preserve `null` as a distinct
  bucket; the chart can render it as "(unknown)".
- **`bridge cost` CLI parity.** v2 plan acceptance says "numbers must
  match `bridge cost` CLI ± $0.01". The CLI also reads the same
  `tasks` table with the same `status='done' AND cost_usd IS NOT NULL`
  filter; the dashboard sums the same column. Spot-check during the
  PHASE-BROWSER-TEST step.
- **Recharts SSR.** The chart wrapper is `"use client"`, so the page
  ships a `<dynamic>` boundary. KPIs and empty state are still
  server-rendered for the FCP budget. Recharts emits inline SVG so no
  flash-of-unstyled chart on first paint.
- **No mutation guard.** The router has only `query` procedures. The
  review file's checklist verifies this.
