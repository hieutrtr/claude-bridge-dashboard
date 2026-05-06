# P2-T05 — Audit log viewer page

> Read-side surface over the dashboard-owned `audit_log` table that T04
> shipped. Lands at slot 10/15 — after every Phase 2 mutation
> (T01 dispatch, T03 kill, T06 loop approve/reject) and the
> entry-guard auditors (T07 rate-limit, T08 CSRF) have been writing
> rows for several iterations. The viewer reuses the URL-param +
> server-component pattern from `/tasks` (Phase 1 T05); no client
> mutation, no SSE, no virtualisation library. Pagination keeps each
> page bounded so a 50 000-row table stays performant without a
> windowed renderer.

## References

- **v1 ARCH §4.6** — `system.auditLog({ since?, until?, action?, userId?, limit?, cursor? })` is the canonical reader procedure name. We mirror its filter set under the `audit.list` namespace (we keep the new `audit.*` router instead of `system.*` so the app router stays organised by resource).
- **v1 ARCH §11** — perf budget: virtualized table for 5 000+ rows. We satisfy it by **paginating** at 100 rows/page (cursor on `id < ?`) — the wire payload stays well under 100 KB and the rendered DOM under 500 nodes, which beats a virtualizer on first-paint and keeps the page server-rendered. The 5 000-row smoke test asserts the SQL query (with all filters + cursor) returns in < 50 ms p95.
- **INDEX §"Phase 2 task list" T05** — *"`/audit` route, owner-only, virtualized table (5 000+ rows), filters by user/action/resource/date. Reuses `<TaskFilters>` URL-param pattern from Phase 1."* — the URL-param pattern is the load-bearing requirement; "virtualized" is satisfied by pagination per the perf-budget note above.
- **T04 spec §"Acceptance criterion 8"** — *"Owner-only enforcement is T05's responsibility. T04 ships the write side only."* This task closes that gap.
- **`src/db/schema.ts` (lines 170–185)** — `auditLog` Drizzle table with two indexes (`idx_audit_log_created_at`, `idx_audit_log_user_created_at`) — both serve the queries this task issues.
- **`tasks` router pattern** (`src/server/routers/tasks.ts` `list` procedure) — the cursor + filter shape we mirror.
- **`task-filters.tsx` + `app/tasks/page.tsx`** — the URL-as-state pattern we replicate for `/audit`.

## Acceptance criteria

1. **`audit` router.** `src/server/routers/audit.ts` exports `auditRouter` with one query procedure:
   - `list({ action?, resourceType?, userId?, since?, until?, limit?, cursor? })`
     - `action` — exact-match (`audit_log.action = ?`).
     - `resourceType` — exact-match.
     - `userId` — exact-match; empty-string sentinel `"<anonymous>"` filters rows with `user_id IS NULL` (rate-limit-login + csrf-invalid pre-auth rows).
     - `since` / `until` — ms-epoch integer ≥ 0; mapped to `created_at >= ?` / `created_at <= ?`.
     - `limit` — int 1..200 (default 100).
     - `cursor` — positive int; `id < ?` keyset.
   - Returns `{ items: AuditLogRow[], nextCursor: number | null }`.
   - Order: `created_at DESC, id DESC` (stable under same-millisecond inserts).
2. **DTO.** `src/server/dto.ts` adds `AuditLogRow` mirroring the schema columns *plus* a parsed `payload` (best-effort `JSON.parse(payload_json)`; on parse-fail the raw string survives in `payloadJson` and `payload` is `null`).
3. **Wire registration.** `src/server/routers/_app.ts` adds `audit: auditRouter`.
4. **`/audit` page.** `app/audit/page.tsx`:
   - Server component. Reads `searchParams` (`action`, `resourceType`, `userId`, `since`, `until`, `cursor`).
   - Calls `audit.list` via `appRouter.createCaller({})`.
   - Renders a filter strip (`<AuditFilters>` mirroring `<TaskFilters>` shape) + a `<AuditLogTable>` (id, created_at, user, action, resource, ip_hash short, request_id short).
   - "Next →" link advances cursor while preserving filters.
   - Empty / filtered-empty states copy the `/tasks` Card pattern (offline if 0 rows even unfiltered → "no audit rows yet").
5. **Sidebar entry.** `src/lib/nav.ts` gains `{ label: "Audit", href: "/audit" }` (after Cost). `tests/lib/nav.test.ts` (or the existing nav test, if any) must still pass; if no nav test exists today, T05 does not introduce one.
6. **Owner-only enforcement.** Phase 2 has no real auth context yet (Phase 1 stubbed JWT cookie auth via middleware, but the dashboard has only one user — "owner"). The viewer is **gated by the same middleware that gates every other page**. We do *not* add a second auth check inside the procedure: the only caller path is the server component, which middleware protects. ADR + PHASE-2-COMPLETE warn that multi-user requires a real `ctx.user.role === "owner"` check at the procedure boundary.
7. **Performance.** With 5 000 audit rows seeded:
   - `audit.list({ limit: 100 })` returns in < 50 ms p95 (asserted in a smoke test on the integration suite).
   - `audit.list({ action: "task.dispatch", limit: 100 })` returns in < 50 ms (uses the `idx_audit_log_created_at` index because the `action` filter is post-index — the smoke test still asserts the budget; if the DB were larger we'd add an `idx_audit_log_action_created_at` index, but at 5 k rows the seq scan inside the index range stays under budget).
8. **Privacy.** `payload_json` is shown verbatim (no second redaction layer) — T04 already redacted `password` keys before write. The viewer surfaces `ip_hash` (already SHA-256-salted, never the raw IP) and `user_agent`. The detail-cell renders `payload_json` inside a `<pre>` so a user pasting the audit row into a screenshot doesn't accidentally reflow JSON.
9. **No mutation.** This task adds zero MCP calls, zero CSRF/rate-limit-guarded routes, zero `audit_log` writes. It is a query-only surface — read invariant restored for this slice.

## Non-goals

- A virtualization library (react-window / react-virtuoso). Pagination
  satisfies the 5 000-row budget without DOM-layer engineering.
- CSV / JSON export. Future Phase 4 dashboard-admin task.
- Live tail (`/api/stream/audit`). The Tasks SSE was P1-T08; an audit
  SSE would duplicate the pattern with no near-term consumer. Filed as
  a follow-up if an operator asks.
- Searching `payload_json` substrings. SQLite JSON1 lets us add `WHERE
  payload_json LIKE '%foo%'` cheaply, but the UX is unclear (regex?
  case?). Defer to first user request.
- Deletion / pruning. Owner can `DELETE FROM audit_log WHERE created_at
  < ?` manually; documented in PHASE-2-COMPLETE.md.
- Multi-user owner-only enforcement at procedure level. See acceptance
  criterion 6 — single-user dashboard, middleware-gated. Phase 4 will
  layer `ctx.user.role`.

## TDD plan (RED → GREEN)

### Integration — `tests/server/audit-router.test.ts` (new)

Set-up: tmp file DB, `runMigrations(db)` to create `audit_log`,
`__setAuditDb(db)` so direct `appendAudit` calls land in the same DB,
`process.env.BRIDGE_DB = path` + `resetDb()` so `getDb()` opens the
same file.

1. **Empty DB.** `audit.list({})` returns `{ items: [], nextCursor: null }`.
2. **Order.** Seed 3 rows with strictly-increasing `created_at`. `audit.list({})` returns them DESC by `created_at` (newest first) with matching DESC `id`.
3. **Default limit + paging.** Seed 250 rows. Default limit (100) returns 100 items + non-null `nextCursor`. Following the cursor returns the next 100; following again returns 50 items with null `nextCursor`.
4. **Custom `limit`.** `audit.list({ limit: 5 })` returns 5 items.
5. **`limit` clamped at 200.** `audit.list({ limit: 500 })` is a Zod error (`BAD_REQUEST`).
6. **Filter `action`.** Seed mixed `task.dispatch` + `task.kill` rows. `audit.list({ action: "task.dispatch" })` only returns the dispatch rows.
7. **Filter `resourceType`.** `audit.list({ resourceType: "loop" })` only returns loop rows.
8. **Filter `userId`.** `audit.list({ userId: "owner" })` only returns rows whose `user_id = 'owner'`.
9. **Filter `userId = "<anonymous>"`.** Returns rows with `user_id IS NULL` (rate-limit-login pre-auth, csrf_invalid pre-auth).
10. **Filter `since` / `until`.** Seed 5 rows with `created_at` 1–5 ms-epochs. `since: 3, until: 4` returns rows 3 and 4 only.
11. **Combined filters.** `action="csrf_invalid"` + `since=…` + `until=…` returns the AND intersection.
12. **`payload` parsing.** Row with `payload_json = '{"agentName":"x"}'` — DTO surfaces `payload: { agentName: "x" }` and `payloadJson: '{"agentName":"x"}'`.
13. **Invalid JSON `payload_json`.** Row with `payload_json = '{not json'` — DTO surfaces `payload: null` and the raw `payloadJson` string.
14. **Cursor advances stably.** Two rows share the same `created_at` ms; cursor pagination at the boundary returns each row exactly once (covers the `id` tie-break).
15. **`payload_json = null`.** DTO surfaces `payload: null` and `payloadJson: null`.

### Smoke perf — `tests/server/audit-router-perf.test.ts` (new)

Seed 5 000 rows with mixed actions / users. Run the three `audit.list`
calls below in a loop (10 iters each) and assert the median wall-clock
< 50 ms. Tagged `if (process.env.BUN_TEST_PERF !== "0")` so we can skip
on slow CI.

- `audit.list({ limit: 100 })`
- `audit.list({ action: "task.dispatch", limit: 100 })`
- `audit.list({ since: <mid-range>, limit: 100 })`

### Component / page render — covered by build + e2e

The page is a thin server component composing `<AuditFilters>` +
`<AuditLogTable>`. Both are presentational; no per-component test in
Phase 2 (the existing `<GlobalTaskTable>` precedent ships untested
beyond visual smoke). Playwright smoke updated at slot 14 (phase test
sweep) — out of scope for this task.

## Implementation outline

### `src/server/routers/audit.ts`

```ts
import { z } from "zod";
import { and, desc, eq, gte, isNull, lt, lte } from "drizzle-orm";

import { publicProcedure, router } from "../trpc";
import { getDb } from "../db";
import { auditLog } from "../../db/schema";
import type { AuditLogPage, AuditLogRow } from "../dto";

const ListInput = z.object({
  action: z.string().min(1).optional(),
  resourceType: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),    // "<anonymous>" sentinel
  since: z.number().int().min(0).optional(),
  until: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).default(100),
  cursor: z.number().int().positive().optional(),
});

export const auditRouter = router({
  list: publicProcedure
    .input(ListInput)
    .query(({ input }): AuditLogPage => { /* drizzle SELECT */ }),
});
```

DTO parser handles JSON payload safely (try / catch around
`JSON.parse`, never throws).

### `src/server/dto.ts` (extend)

```ts
export interface AuditLogRow {
  id: number;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  payloadJson: string | null;
  payload: unknown | null;     // best-effort JSON.parse, null on fail / null source
  ipHash: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: number;           // ms epoch
}

export interface AuditLogPage {
  items: AuditLogRow[];
  nextCursor: number | null;
}
```

### `app/audit/page.tsx`

Same shape as `app/tasks/page.tsx`: extract `readString`, `readNum`
(for `since`/`until`/`cursor`) helpers, build search string, call
`audit.list` via `createCaller`, render `<AuditFilters>` +
`<AuditLogTable>`.

### `src/components/audit-filters.tsx` + `src/components/audit-log-table.tsx`

Both presentational. `<AuditFilters>` is a `<form method="get">`;
`<AuditLogTable>` mirrors `<GlobalTaskTable>` (Card empty state, Next
link). Created-at rendered as ms epoch + relative ("3 m ago") via a
small inline helper — no new lib dep.

### `src/lib/nav.ts`

Add `{ label: "Audit", href: "/audit" }` after Cost.

### `src/server/routers/_app.ts`

```ts
import { auditRouter } from "./audit";
…
export const appRouter = router({
  agents: agentsRouter,
  analytics: analyticsRouter,
  audit: auditRouter,
  loops: loopsRouter,
  tasks: tasksRouter,
});
```

## Risk + mitigation

| Risk (from PHASE-2-REVIEW + ARCH §10–11) | Mitigation in this task |
|------------------------------------------|-------------------------|
| **Owner-only enforcement is single-layer (middleware).** A future contributor may expose the procedure to a per-team caller without re-checking the role. | Procedure-level role check is filed as Phase 4 ADR work in PHASE-2-COMPLETE. The router file's docblock states *"Single-user dashboard — middleware-gated. If/when multi-user lands, add `ctx.user.role === 'owner'` at the procedure boundary."* |
| **5 000-row table renders too slowly without virtualisation.** | Pagination at 100 rows/page — the rendered DOM is bounded. The smoke perf test asserts the SQL side stays < 50 ms. |
| **`payload_json` may carry sensitive data despite T04 redaction.** | T04 already redacts `password` keys at write-time; the viewer is no laxer than the writer. The viewer surfaces a `<pre>` so the user can audit what they're sharing in a screenshot. We add no second redaction (would mask a true T04 bug). |
| **Sub-millisecond inserts share `created_at`** → cursor on `created_at` alone could skip rows. | Cursor is on `id` (`id < ?`); ordering uses `(created_at DESC, id DESC)` so ties break consistently. Test 14 asserts this. |
| **Filter for `userId = NULL`.** Drizzle's `eq(col, null)` produces wrong SQL. | Sentinel `"<anonymous>"` resolved to `isNull(auditLog.userId)` in the procedure (matches the `null`-row semantics test 9 asserts). |
| **`audit_log` action set is open** (T01..T09 each invent their own labels). The filter UI cannot enumerate. | `<AuditFilters>` action input is a free-text field, not a `<select>`. Future Phase 4 admin page can add a "popular actions" datalist sourced from `SELECT DISTINCT action`. |
| **Schema drift if daemon ships its own `audit_log` later.** | T04 already documents this risk (vendored schema flagged as dashboard-owned). T05 inherits the warning unchanged. |
| **Smoke perf test flaky on CI** (load-dependent). | Median over 10 iterations + 50 ms budget is generous (observed ~5 ms locally on M-series). Skippable via `BUN_TEST_PERF=0`. |
