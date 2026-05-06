# T04 — Multi-user cost view — code review

> **Reviewer:** loop iter 5 self-review · **Status:** done · **Risk:** Low

## Scope

Single new tRPC query (`analytics.costByUser`), single new client leaf
(`<CostByUser>`), `/cost` page extended with a `?tab=user` view. No
schema changes (re-uses `tasks.user_id` from Phase 0 vendored schema +
`users` from P4-T01). 9 new router cases + 5 new component cases + 3
new page cases. All 1160 unit tests + build pass after the change.

## Acceptance check vs INDEX (T04 row)

| Criterion                                                                                | Status |
|------------------------------------------------------------------------------------------|--------|
| Numbers match `audit_log` ↔ `tasks` join — cross-checked in test                        | ✅ test (2) cross-checks `costByUser.totalCostUsd` against `analytics.summary.totalCostUsd` for the same window. INDEX wording cites `audit_log` but the `tasks` table is the load-bearing reference for cost columns; both procedures share the same `status='done' AND cost_usd IS NOT NULL AND completed_at >= since` predicate. |
| Member sees own row only                                                                 | ✅ `analytics-router.test.ts` "member callers see ONLY their own row" — `u-other`'s spend is not visible. |
| Owner sees all + correct % share                                                         | ✅ "owner sees per-user buckets sorted by costUsd DESC" + "shareOfTotal sums to 1". |
| `(unattributed)` bucket visible to owners only                                           | ✅ owner-branch tests (4) + (5) + (6); the member branch never invokes the JOIN — they get their own user_id-filtered row only. |
| Phase 4 invariant: query, no audit, no CSRF, no rate-limit                               | ✅ `authedProcedure` is a `t.procedure.use(...)` chain that wraps queries with the auth guard only — CSRF and rate-limit middlewares only attach to mutation procedures. No `appendAudit` call sites. |

## Question matrix (loop rules §Rule 3)

> **Auth:** token expiry + secure cookie?
> Out of scope for T04 — read-only query. The auth gate is inherited
> from `authedProcedure`, which already enforces session + revocation
> checks (T01/T02/T03 invariants). Token expiry sits with T01.

> **RBAC:** 403 cover all mutation routes?
> Not relevant — T04 introduces zero mutations. The query branch
> divides on `caller.role` and uses two distinct SQL paths (member
> filters by `tasks.user_id`; owner JOINs `users WHERE revoked_at IS
> NULL`). A member cannot reach the owner branch — the role check is
> at the top of the procedure body, before any SQL.

> **Mobile:** Lighthouse ≥ 90?
> Deferred to T07 (mobile responsive pass) — same deferral pattern as
> Phase 3. The new leaderboard table uses `overflow-x-auto` so it does
> not introduce horizontal-scroll regressions at iPhone width 390px;
> verified by inspection of the markup. Lighthouse run lands in T07.

> **Email:** rate limit (anti-abuse)?
> Not applicable — T04 ships zero email surface. Email rate-limit
> review sits with T01 (magic-link) + T06 (digest).

## Privacy / security

1. **Email plaintext on the wire.** The leaderboard renders the user's
   email — same column the `/users` page already exposes to owners
   (T02). Members only ever see THEIR OWN email (and only because
   `caller.email` is plumbed through the synthetic owner row OR the
   `users` lookup). The privacy boundary is the `audit_log`, not the
   API surface; this query writes nothing to audit.

2. **`(unattributed)` bucket is opaque.** Three causes collapse into
   the same NULL key:
     - `tasks.user_id IS NULL` (legacy CLI pre-Phase 4);
     - `tasks.user_id` points at an unknown id (manually-edited DB);
     - `tasks.user_id` points at a revoked user.

   Splitting them would leak revocation status to anyone with the
   cost view open. Forensics should pivot via `audit_log` (filter
   `tasks.user_id` directly) rather than the cost dashboard. Recorded
   in T04 task file §"Decisions / non-obvious calls" #1.

3. **No PII in tests.** All test seeds use `*@example.com` (RFC 2606
   reserved for documentation) — same convention as `users-router.test.ts`.

4. **`callerRole` on the wire is intentional.** Already discoverable
   client-side via `auth.me`; emitting it on this payload saves a
   round-trip and clarifies the render contract. No new privacy
   surface is opened.

## Failure-mode discipline

- **Empty DB on either branch.** Owner gets `rows: []` + zeros; member
  gets `rows: []` + a zero-fill `selfRow`. No NaN. Both verified.
- **Mixed window with revoked + null + unknown user_ids.** All three
  collapse into the unattributed bucket; the bucket is summed
  correctly (test (4) + (5) + (6)).
- **Cross-procedure totals.** `costByUser.totalCostUsd` is asserted
  to match `summary.totalCostUsd` for the same window. If the SQL
  predicate ever drifts between the two procedures, this test breaks
  — by design.
- **Sort determinism.** When two users tie on `costUsd`, the sort
  falls back to `email ASC` (NULLS LAST) then `userId ASC`. Same
  result on every run; the unattributed bucket lands at the bottom
  on ties, which is what the eye expects.

## Surface diff (load-bearing)

| File                                                            | Change                                                                              |
|-----------------------------------------------------------------|-------------------------------------------------------------------------------------|
| `src/server/routers/analytics.ts`                               | + `analytics.costByUser` query (~110 lines).                                       |
| `src/server/dto.ts`                                             | + `CostByUserRow`, `CostByUserPayload` interfaces.                                  |
| `src/components/cost-by-user.tsx`                               | NEW. Pure render; owner / member branches.                                          |
| `app/cost/page.tsx`                                             | + tab strip + window picker + eager body resolution.                                |
| `tests/server/analytics-router.test.ts`                         | + `users` seed helper + 9 cases.                                                    |
| `tests/app/cost-page.test.ts`                                   | + 3 cases (tab strip, empty user tab, unattributed bucket).                         |
| `tests/app/cost-by-user.test.tsx`                               | NEW. 5 component-render cases.                                                      |
| `docs/tasks/phase-4/T04-multi-user-cost.md`                     | NEW. Task spec.                                                                     |
| `docs/tasks/phase-4/T04-review.md`                              | NEW. This file.                                                                     |

## What I deliberately did NOT do

1. **A bar / horizontal-bar leaderboard chart.** Filed against v0.2.0;
   the table reads better at mobile width and is screen-reader-first.
2. **`?since=` / `?until=` custom range pickers.** The 24h / 7d / 30d
   selector matches `analytics.summary` and keeps the URL space tight.
3. **Per-user history sparkline.** Would need a separate
   `costByUserDaily` procedure; v0.2.0.
4. **Sidebar "Top 5" widget.** Adds cross-cutting plumbing for
   nothing the `/cost` page can't already surface; v0.2.0.
5. **Bucket loop / schedule cost into the leaderboard.** The daemon's
   `loops.totalCostUsd` and `schedules.runs` cost are derivable from
   `tasks.cost_usd` (the loop / schedule rows reference task ids).
   Folding them in here would double-count. The existing `tasks`
   aggregation is correct.

## Behavioural observations from the loop

- **Migration runner already ran.** The `users` table was created by
  P4-T01's migration `0002_users.sql` — T04 needed only a seed helper
  in tests. The `runMigrations` IF-NOT-EXISTS pattern made this
  invisible work.
- **`authedProcedure` middleware paid dividends.** Member branch logic
  fits in 25 lines because role narrowing is already done by the
  procedure middleware (T03). Pre-T03 this would have needed inline
  `requireAuth` + manual role branching.
- **No Recharts addition.** Reused the existing `<CostCharts>` for the
  By day tab; no new client bundle weight was introduced. Confirmed
  via the build output (`/cost` route bundle size unchanged from
  Phase 1: 109 kB).

## Outstanding follow-ups (filed)

- v0.2.0: cost-by-user bar chart variant.
- v0.2.0: cost-by-user history sparkline.
- v0.2.0: custom `?since=` / `?until=` range pickers across `/cost`.
- v0.2.0: budget alerts when a user crosses a threshold (depends on
  T06 push delivery, also v0.2.0).
- v0.2.0 (ARCH §11 perf budget gate): Lighthouse-CI assertion for
  `/cost?tab=user` once T07 mobile pass lands.
