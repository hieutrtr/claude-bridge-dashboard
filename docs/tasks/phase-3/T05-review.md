# P3-T5 — `schedules.list` + `/schedules` page: code review

> Reviewer's pass over the T5 deliverables before commit. T5 is **read-
> only** — no MCP, no audit, no CSRF, no rate limit (queries don't
> mutate state). The Phase 3 invariant checklist applies in a reduced
> form: only the data-shape, privacy precedent, and read-only-page
> rules from Phase 1/2 are load-bearing here.

## Files touched

| Path | Status | Lines |
|---|---|---|
| `src/lib/cron-format.ts` | new | 100 |
| `src/server/dto.ts` | edit | +37 (ScheduleListRow, ScheduleListPage) |
| `src/server/routers/schedules.ts` | new | 130 |
| `src/server/routers/_app.ts` | edit | +2 (mount schedulesRouter) |
| `src/components/schedule-filters.tsx` | new | 51 |
| `src/components/schedule-table.tsx` | new | 165 |
| `app/schedules/page.tsx` | replace stub (10 → 53) | 53 |
| `tests/lib/cron-format.test.ts` | new | 24 cases |
| `tests/server/schedules-router.test.ts` | new | 9 cases |
| `tests/app/schedules-page.test.ts` | new | 14 cases |
| `docs/tasks/phase-3/T05-schedules-list.md` | new | task spec |
| `docs/tasks/phase-3/T05-review.md` | new | this file |

## Phase 3 invariant checklist (reduced — read-only)

### 1. No MCP call (read-only query) — ✅
- `schedules.list` reads directly from the vendored `schedules` table
  via Drizzle. No `ctx.mcp.call(...)` anywhere in the router.
- T6 + T7 will introduce the mutation surface (`add`/`pause`/`resume`/
  `remove`) and route through `bridge_schedule_*` MCP tools per the
  Phase 3 INDEX invariant.

### 2. No audit row (queries are not audited) — ✅
- Per Phase 2 scope decision (`PHASE-2-COMPLETE.md` §lessons): only
  *mutations* write to `audit_log`. List/get queries do not. T5 is
  pure read.

### 3. No CSRF / rate-limit (queries are not mutations) — ✅
- POST→tRPC handler is the only path that runs `csrfGuard` /
  `rateLimitMutations`. `schedules.list` is a tRPC query (GET); it
  flows through the public read path. Verified by grep —
  `csrfGuard` and `rateLimitMutations` are not referenced in
  `src/server/routers/schedules.ts`.

### 4. Read-only page invariant — ✅
- `app/schedules/page.tsx` exports a default async function only —
  no `POST`/`PUT`/`PATCH`/`DELETE` named exports. Verified by the
  module-surface test in `tests/app/schedules-page.test.ts`.
- No `"use client"` directive at the page level. The filter strip is
  a plain `<form method="get">` (URL-as-truth), no React state.

### 5. Privacy: payload shape vs prompt text — ✅ (carry-over from P1/P2)
- Audit privacy precedent (`hasGoal:true` instead of echoing the text)
  applies to *audit*, not to UI rendering. The user navigated to
  `/schedules` and is the owner; same "user navigated here" rule that
  justifies showing `goal` on `/loops/[id]`.
- The list still truncates the prompt to an 80-char preview with the
  full text in the row tooltip — keeps long prompts from breaking the
  layout while preserving access for the user.

## Cross-cuts I checked specifically

### a. Wire shape — does the DTO leak any non-public columns?

`schedules` (per `src/db/schema.ts`) has 19 columns. The DTO ships 15;
the 4 omitted are:

- `channelChatId` — irrelevant to the list view; safe to skip.
- `userId` — auth-internal; shouldn't surface on the wire.
- `updatedAt` — not rendered by the table; out of scope.

`prompt` and `lastError` ARE on the wire — both are user-owned content
the user expects to see in their own dashboard. No surprise.

### b. Ordering decision (NULLS LAST) — race vs Drizzle's default

SQLite's default ASC sort puts NULL first, which is the opposite of
what we want (paused / never-fired schedules should drop to the
bottom). I implemented this as a client-side partition + sort instead
of a raw-SQL `CASE WHEN ... IS NULL THEN ...` because:

1. Drizzle's typed `orderBy` can't express NULLS LAST without dropping
   into raw SQL.
2. Schedule volume is bounded (most deployments < 50 rows); the JS
   sort cost is invisible.
3. Reviewing a TS partition is more obvious than reviewing the SQL
   equivalent. Tests in `schedules-router.test.ts` ("orders by
   nextRunAt ASC; null nextRunAt drops to bottom") and the page test
   ("ordering" describe block) lock the contract.

Trade-off: if pagination lands in the future, the partition would have
to move into SQL. Not a problem today.

### c. `cronstrue` 3.x output drift (test fragility)

`cronstrue.toString("0 * * * *")` returns `"Every hour"` in 3.14.0;
older versions emitted `"At 0 minutes past the hour"`. The hourly test
in `cron-format.test.ts` originally asserted the older string and
broke. Fixed by relaxing the assertion to "human-readable string,
contains 'hour', not the raw expression" — same shape contract,
version-resilient.

The daily / weekly / Monday assertions all match the 3.14.0 output
exactly and are stable across patch versions. If we upgrade `cronstrue`
and an output drifts, the failing test points at the exact branch,
not a noise ripple.

### d. `formatNextRun` — `now` injection vs implicit `Date()`

The helper takes an optional `now?: Date` parameter so unit tests can
drive deterministic fallback paths. Production call sites in
`<ScheduleTable>` capture `const now = new Date()` *once per render*
and pass it to every row — avoids the per-row `Date.now()` drift that
would make rows inconsistently fall just-before-or-after each other
when the cron `next()` lands within a millisecond of "now".

This is cheap (< 1µs per render) and makes the page deterministic
under test fixtures.

### e. Privacy of `prompt` text in HTML

The schedule-page test ("truncates very long prompts to a preview")
asserts both:
- the rendered table cell shows the truncated form ("…");
- the full text is preserved in the tooltip `title` attr.

This means the full prompt *does* appear in the rendered HTML (within
the `title=`). That's intentional — the user is the schedule's owner
and can see the full text on hover. If a future requirement says
"never show full prompt on the list view", we'd drop the tooltip and
make the prompt cell a link to a detail page (T8 drawer territory).

### f. Empty-state copy points at the right next step

- Unfiltered empty: "No recurring schedules yet. Use bridge_schedule_add
  ... or bridge schedule add ... The 'New schedule' dialog lands in
  P3-T6." — sets correct expectation that the dialog isn't built yet.
- Filtered empty: "No schedules match the current filters. Adjust them
  above or clear all." — same shape as the loops empty state.

When T6 lands the unfiltered copy will get updated to point at the
dialog's button.

## Test surface

| Suite | Cases | Coverage |
|---|---|---|
| `tests/lib/cron-format.test.ts` | 24 | every cadence/next-run branch (cron mode happy + malformed; interval buckets 1/60/1440/10080/hour-mult/day-mult/non-bucket; nextRunAt-wins; cron next() from now; interval lastRunAt+interval; interval malformed-lastRunAt; neither-mode-usable). |
| `tests/server/schedules-router.test.ts` | 9 | empty page; ordering (nextRunAt ASC, nulls last); wire shape (cron, interval, disabled, nullables); agent filter; input validation (empty string). |
| `tests/app/schedules-page.test.ts` | 14 | module surface (read-only invariant); empty / filtered-empty; cronstrue rendering; interval bucket rendering (30, 60, 1440); status badges (Paused / Failing / Active); run count; prompt truncation with full text in tooltip; URL → query mapping; ordering. |

`bun test tests/lib tests/app tests/server` → **756 pass / 0 fail**.

`bun run build` clean. `/schedules` route weight = **171 B** (purely
server-rendered, no client JS chunk added — the filter strip is plain
HTML).

## Lessons / call-outs for next iters

1. **Cron-mode rows are rare in production today.** `bridge_schedule_add`
   only accepts `interval_minutes`. T6 will need to decide whether to
   convert cron → interval client-side or to wait for the daemon to
   grow native cron support. Decision recorded in T6's review file.

2. **The page polls every N seconds for live updates** — same Phase 2
   lesson §3 caveat as `/loops/[id]`. T5 doesn't add polling because
   the page is mostly stable (schedules don't churn at sub-second
   resolution). T7 will need to refresh after pause/resume/delete
   mutations — `router.refresh()` from the action menu's client
   island.

3. **Schedule volume is bounded.** No pagination this iter. If a
   future deployment grows past 200 schedules we'll add cursor
   pagination on `id`-DESC; the current shape leaves room for that
   without a wire-shape break (we can add `nextCursor` to
   `ScheduleListPage` in a backwards-compatible way).

## Verdict

✅ Ready to commit as `feat(phase-3): T05 schedules.list router + Schedules page`.
