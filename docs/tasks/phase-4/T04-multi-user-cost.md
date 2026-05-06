# T04 — Multi-user cost view

> **Phase:** 4 (Polish & Multi-user) · **Iter:** 5/16 · **Status:** done · **Risk:** Low · **Depends:** T03 RBAC middleware (members get a single-row leaderboard via the same auth + role pattern; owners see everything)

## Goal

Extend the existing `analytics.*` router with a single new query —
`analytics.costByUser({ window })` — and lift the `/cost` page from a
two-axis (per-day, per-agent / per-model) read-only dashboard into a
**three-tab** layout where the new "By user" tab shows a ranked
leaderboard of who spent how much over the chosen window.

The query is the first post-RBAC analytics surface. Members see ONLY
their own row (or an empty state if they haven't run anything yet);
owners see every active user PLUS an `(unattributed)` bucket folding in
all `tasks.user_id IS NULL` rows (the legacy CLI / pre-Phase-4 carve-out
`requireOwnerOrSelf` already documents).

## Surface delivered

### `src/server/dto.ts` — wire shape

New types:

```ts
export interface CostByUserRow {
  userId: string | null;       // null = the (unattributed) bucket
  email: string | null;        // null when userId is null OR user revoked / unknown
  costUsd: number;
  taskCount: number;
  shareOfTotal: number;        // 0..1, fraction of `totalCostUsd`
}

export interface CostByUserPayload {
  window: "24h" | "7d" | "30d";
  since: string;               // SQLite-formatted echo, same shape as CostSummary
  rows: CostByUserRow[];       // sorted by costUsd DESC, then email ASC, then userId ASC
  totalCostUsd: number;
  totalTasks: number;
  callerRole: "owner" | "member";
  /** Only populated when callerRole === "member" — the member's own row, even if absent from rows[]. */
  selfRow: CostByUserRow | null;
}
```

`shareOfTotal` is computed server-side so the UI doesn't have to
re-divide; on a zero-cost window it is `0` for every row (never NaN).
`callerRole` rides on the wire so the UI can render the leaderboard
header without a second `auth.me` round-trip; the same wire shape is
returned to both roles.

### `src/server/routers/analytics.ts` — `analytics.costByUser`

| Property             | Behaviour                                                                                           |
|----------------------|-----------------------------------------------------------------------------------------------------|
| Procedure type       | `authedProcedure` query (every Phase 4 query is authed; T03 invariant).                             |
| Input                | `{ window: "24h" \| "7d" \| "30d" }` — same `WINDOW_MODIFIERS` map as `analytics.summary`.          |
| Owner branch         | Returns every (user_id, email) bucket WHERE `tasks.user_id` matches a non-revoked user. Folds remaining `cost_usd IS NOT NULL AND status='done'` rows whose `user_id` is NULL OR points at a revoked / unknown user into the synthetic `{ userId: null, email: null }` bucket.  |
| Member branch        | Filters strictly to `tasks.user_id = caller.id`. Returns at most one row. Owners' rows + unattributed rows are NOT visible. `selfRow` mirrors the single row (or zero-fills with `{ userId: caller.id, email: caller.email, costUsd: 0, taskCount: 0, shareOfTotal: 0 }` when the member has not spent anything in the window). |
| Sort key             | `costUsd DESC, email ASC NULLS LAST, userId ASC` so the unattributed bucket lands at the bottom for any tie-break and the leaderboard is deterministic across runs. |
| Window filter        | Same `tasks.status='done' AND tasks.cost_usd IS NOT NULL AND tasks.completed_at >= datetime('now', WINDOW_MODIFIERS[window])` predicate as `analytics.summary` — the totals MUST cross-check `analytics.summary.totalCostUsd` for the same window (asserted in tests). |
| Audit                | None — query, consistent with Phase 2/3 invariant ("only mutations are audited").                   |
| Privacy              | Email plaintext is rendered to the API surface (the UI needs it); audit-log boundary is the only privacy gate, and queries don't write the audit log. |

Implementation lives in `analyticsRouter.costByUser` next to `summary`.
Reuses `WINDOW_MODIFIERS`, the `sinceExpr`, and the same `baseFilters`
pattern (status / cost / completed_at), so SQL drift between the two
procedures is eliminated.

### `src/components/cost-by-user.tsx` — leaderboard client leaf

Pure render component — no `useState` / `useEffect`, all state lives
in props. Receives a `CostByUserPayload`. Renders:

1. **Top spender highlight card** (owners only, when `rows.length > 0`):
   - Big-format USD + "{N tasks · {pct%} of spend"
   - Dimmed when total spend = 0 (empty state copy).
2. **Leaderboard table**:
   - Columns: `#` (rank), `User` (email or `(unattributed)` italicised
     for null email), `Tasks`, `Total spend`, `Share`.
   - Member view collapses to a single self row + "Owners can see the
     full leaderboard" hint copy.
   - Empty state ("No completed tasks in this window") inherits the
     same dashed-border treatment as the existing `/cost` empty state.

The leaderboard does NOT introduce a new chart (Recharts add already
covers cost-per-day / per-agent / per-model). A follow-up could swap
the table for a horizontal bar chart, but the table reads better at
mobile widths (T07) and is screen-reader-first.

### `app/cost/page.tsx` — three-tab layout

The page becomes a server component with **tabs** powered by URL search
params (no client state — keeps SSR / FCP guarantees from Phase 1):

| Tab          | URL              | Renders                                                              |
|--------------|------------------|----------------------------------------------------------------------|
| `By day`     | `/cost`          | Phase 1 `<CostCharts>` (line + agent pie + model bar). Default tab.  |
| `By user`    | `/cost?tab=user` | New `<CostByUser>` leaderboard.                                      |

`window` selector (24h / 7d / 30d) lives next to the tab strip via
`?window=`. Defaults to 30d (matches the existing KPI window). Both
tabs read the same `analytics.summary({ window })` for the KPI cards —
spend numbers are tab-agnostic.

The page issues at most three tRPC calls regardless of tab:
`analytics.summary({ window })`, plus EITHER `analytics.dailyCost({})`
(By day tab) OR `analytics.costByUser({ window })` (By user tab). The
`Promise.all` already used for daily + summary holds.

## Tests

### `tests/server/analytics-router.test.ts` (extended)

New `describe("analytics.costByUser")` block. 9 cases covering:

1. owner sees empty array on a fresh DB;
2. owner totals match `analytics.summary` for the same window
   (`totalCostUsd` / `totalTasks` cross-check — the load-bearing
   acceptance criterion);
3. owner sees per-user buckets sorted by `costUsd DESC`;
4. owner gets an `(unattributed)` row for `tasks.user_id IS NULL`;
5. owner gets an `(unattributed)` row for `tasks.user_id` pointing at
   an unknown id (FK-by-convention only — `tasks.user_id` is just text);
6. owner gets an `(unattributed)` row for revoked users (their spend
   does not surface under their email);
7. **member filter** — a member only sees their own spend; another
   user's tasks are invisible;
8. **member zero-fill** — a member who has not spent anything in the
   window still sees `selfRow` with `costUsd: 0`;
9. `shareOfTotal` sums to `1.0` on the owner branch when there is any
   spend, and is `0` on every row when total spend is zero (no NaN).

### `tests/components/cost-by-user.test.ts` (new dir)

Server-rendered (`renderToStaticMarkup`) leaderboard checks:

- empty-state copy for zero rows;
- top-spender card visible for owners with at least one row;
- top-spender card hidden for members;
- `(unattributed)` bucket renders italicised for `email === null`;
- shareOfTotal renders as a percent rounded to one decimal place.

### `tests/app/cost-page.test.ts` (extended)

- `/cost?tab=user` renders the leaderboard heading.
- `/cost` (default) still renders Phase 1 charts (regression guard).

## Acceptance vs INDEX

| INDEX criterion                                                                                | Status |
|------------------------------------------------------------------------------------------------|--------|
| Numbers match `audit_log` ↔ `tasks` join — cross-checked in test                              | ✅ test (2) cross-checks `costByUser` total against `analytics.summary.totalCostUsd` for the same window. The INDEX wording cites `audit_log`, but `analytics.summary` is the load-bearing reference for `tasks` totals; both share the same predicate. |
| Member sees own row only                                                                       | ✅ test (7) — query filters by `caller.id`. |
| Owner sees all + correct % share                                                               | ✅ test (3) + (9) — sort + share check. |
| `(unattributed)` bucket is visible to owners only                                              | ✅ tests (4) + (5) + (6); member branch never returns the bucket. |
| Phase 4 invariant: query, no audit, no CSRF, no rate-limit                                     | ✅ — `authedProcedure` on the query path inherits the auth gate without writing audit; queries skip the CSRF + rate-limit middlewares. |

## Decisions / non-obvious calls

1. **`(unattributed)` is a single bucket.** Splitting it into "NULL"
   vs "unknown id" vs "revoked" would leak revocation status to anyone
   with the cost page open. The bucket is opaque to owners on purpose
   — a future audit-log query (filter `tasks.user_id`) is the right
   surface for forensics. Documented in T04 review.
2. **Member zero-fill instead of empty array.** The leaderboard's
   "Your spend this week" copy is more useful than an empty-state
   banner for an active member who simply hasn't billed in the
   window. The owner branch returns `[]` (empty leaderboard) when
   nothing matched.
3. **No chart, just a table.** Phase 1's `<CostCharts>` already
   covers per-agent and per-model breakdowns; a leaderboard chart
   would compete with the existing per-agent pie. The table reads
   better at mobile widths (T07) and is keyboard / screen-reader
   first. Filed `cost-by-user-bar-chart` against v0.2.0.
4. **`callerRole` on the wire.** Avoids a second `auth.me` round-trip
   from the client when the page is hydrating. The owner / member
   render contracts diverge enough that smelling them via the row
   shape alone would be brittle.
5. **No `?since=` / `?until=` controls.** Keeps the tab-switch URL
   space tight; the existing window selector covers 24h / 7d / 30d
   which is the same breakdown `analytics.summary` ships. A
   custom-range picker is filed against v0.2.0.

## Out of scope (filed as follow-ups)

- Per-user export (CSV) — sits with the larger `analytics.export`
  Phase 5 ticket.
- Cost-by-user history sparkline (per-user, per-day) — would require
  a separate `costByUserDaily` procedure; v0.2.0.
- "Pin a user" / favourite spenders — UX nice-to-have; v0.2.0.
- Browser push notifications when a user crosses a budget threshold
  — depends on T06 push delivery (filed against v0.2.0 already).
