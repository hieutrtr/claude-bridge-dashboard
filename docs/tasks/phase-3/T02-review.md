# P3-T2 — Code review

> Self-review against the Phase 3 invariant checklist (INDEX §
> "Phase 3 invariant — INHERITED FROM PHASE 2") and the v1 P3-T2
> acceptance bullets. Read-only task → most invariant rows are
> "N/A by design" (same shape as T01-review).

## Phase 3 mutation invariant — applicability

| # | Invariant                            | Status   | Reason                                                                 |
|---|--------------------------------------|----------|------------------------------------------------------------------------|
| 1 | Mutation routes through MCP          | **N/A**  | `loops.get` is a query, no mutation surface                            |
| 2 | Travel through MCP pool              | **N/A**  | No MCP call                                                            |
| 3 | CSRF double-submit token             | **N/A**  | tRPC GET; CSRF guard runs on POST mutations only                       |
| 4 | Rate-limit token bucket              | **N/A**  | Bucket binds to mutation POSTs                                         |
| 5 | `appendAudit` before return          | **N/A**  | Queries are not audited per Phase 2 scope decision                     |
| 6 | DangerConfirm wrap                   | **N/A**  | No destructive action — those land in T4                               |

## Privacy review

- ✅ **Goal text IS on the wire** for `loops.get` — by design. Same
  rule the audit log applies to `tasks.result_summary`: never
  *stored* in `audit_log.payload_json`, but freely shown back to a
  user who explicitly navigated to `/loops/[loopId]`. The guard is
  on the **audit** payload, not on the **render** payload. T01
  hides goal from the *list* projection because every row would
  fan-out the leak surface; the detail page is the converse — one
  row, one user-initiated nav, full visibility.
- ✅ No daemon-side disk paths leak: `currentTaskId`, `channel`,
  `channelChatId` cross the wire as the daemon stored them. No
  filesystem path projection.
- ✅ Iteration `prompt` + `result_summary` ARE on the wire. Same
  rationale — the user is on a known loop_id; the prompt is the
  same content the audit log already deliberately omits.

## Input validation

- ✅ `loopId` requires `min(1)` and `max(128)` — matches the
  `bridge_loop_*` daemon-side constraint (loop ids are typically
  ULID-shaped, well under 128 chars).
- ✅ Empty / over-cap inputs return `BAD_REQUEST` (Zod). Tested.
- ✅ Page-level: `decodeURIComponent(rawId).trim()` then re-checks
  length. Empty / over-cap routes through `notFound()` rather than
  surfacing a 400 to the user. Good UX (a 404 is the right answer
  for "loop you asked for doesn't exist").

## SQL surface

- ✅ Two queries per request: one row from `loops` (PK lookup,
  trivial), one COUNT-equivalent over `loop_iterations` filtered by
  `loop_id` (uses `idx_loop_iterations_loop`), and one bounded
  `LIMIT 100` SELECT for the iteration window. **Three statements
  total** — the count query is a `.all().length` call rather than a
  proper `COUNT(*)`. Acceptable for the loops-typical row size; if
  a future loop crosses ~10k iters we'll switch to a proper count
  aggregate. Filed as a perf-watch item in §Follow-ups.
- ✅ All filters bind via Drizzle parameters; no string-concat.
- ✅ The DESC + reverse pattern keeps the cap correctness simple.
  Inline comment explains why we don't use ASC + LIMIT (would
  return the *wrong* 100 — the oldest, not the newest).

## Page-level review

- ✅ **Server component** — no `"use client"` boundary. The
  sparkline is pure SVG; the iteration rows are native
  `<details>` / `<summary>` (per-iter expand state lives in the
  DOM). No JS required to interact.
- ✅ **404 path** — `notFound()` for unknown / empty / over-cap
  `loopId`. Tested with `expect(caught).not.toBeNull()`.
- ✅ **Cross-links**: agent → `/agents/[name]`, iteration's task →
  `/tasks/[task_id]`, breadcrumb back to `/loops`. All
  `<Link>`-driven so SPA nav stays smooth.
- ✅ **Markup-stable test surface**: each section the test
  asserts on carries a `data-testid` (`loop-status-badge`,
  `loop-goal`, `iter-progress`, `budget-progress`,
  `cost-sparkline`, `sparkline-cursor`, `sparkline-cap`,
  `iteration-list`, `iteration-row`). Future styling tweaks won't
  cascade into test churn.

## Sparkline review

- ✅ **Server-component-friendly** — pure SVG, no Recharts (which
  needs a client island for browser measurement). Trade-off
  documented in `T02-loop-detail.md` §lessons: no interactive
  tooltip; the timeline `<details>` rows already give per-iter
  inspection so the trade-off is acceptable.
- ✅ **Edge cases covered**: empty (placeholder + dashed baseline),
  one iter (single dot at right edge), all zeros (max=1e-9 floors
  divide-by-zero). Cursor always renders to give the eye a
  "current position" anchor even with one data point.
- ✅ **Budget cap line** drawn dashed when `maxCostUsd > 0`,
  scaled into the same `max` denominator so the line is
  meaningful even on overshoot. The cap line is hidden when no
  cap is set (matches the "uncapped budget" UX from T1).
- ✅ **A11y**: outer `<svg role="img">` with an `aria-label`
  describing the data shape ("Cumulative cost across N
  iterations: $X"). Empty path uses `aria-hidden="true"` and
  surfaces the explainer copy in plain text below.

## Iteration timeline review

- ✅ **Native `<details>` per iter** — collapsed by default;
  per-iter expand state lives in the DOM. No global toggle —
  acceptance bullet 3 satisfied.
- ✅ **Long-body banner**: when `prompt` or `result_summary`
  exceeds 6 lines, we add a "Long body — scroll within the box"
  hint. The body itself remains readable via the inner overflow.
- ✅ **Status badge per iter** keys off `doneCheckPassed` first
  (the most-meaningful signal for the eye), then status. Same
  variant palette as `loopStatusBadge`.
- ✅ **Truncation banner** — when `iterationsTruncated=true`, we
  render an amber banner with the actual numbers. Same visual
  vocabulary as the transcript truncation banner in
  `app/tasks/[id]/page.tsx`.

## Empty / loading / error states

- ✅ Empty iterations → "No iterations recorded yet" copy.
- ✅ Empty sparkline → dashed baseline + explainer copy.
- ✅ Loading → falls through to the route segment's `loading.tsx`
  (none added in this iter — Next falls back to the parent
  `app/loading.tsx` from Phase 1 T11).
- ✅ Error → tRPC-side errors propagate to the Next.js error
  boundary.

## Wire-shape stability

- ✅ `LoopDetail` is a flat shape — a future per-loop extension
  (e.g. surfacing the daemon's `plan` JSON) can land as a
  nullable column without breaking existing readers.
- ✅ Iteration cap `LOOP_ITERATIONS_LIMIT` is a const at the top
  of the router file — easy to tune per perf data.
- ✅ Page test asserts `data-points` attr (the rendered count)
  rather than counting iterations indirectly. Future cap changes
  surface as test diff in one spot.

## Out-of-scope confirmation

- T3 — Start dialog (lands next iter)
- T4 — Cancel + approve / reject buttons inline (replaces the
  current header-card right-slot; design space already reserved)
- Phase 4 — multiplexed `/api/stream` for live iteration updates

## Test coverage summary

- **8 new server tests** in `tests/server/loops-router.test.ts`
  (covering loops.get unknown id, happy path with iteration
  ordering, empty iterations, nullable cols, 100-row truncation,
  input validation 2x). Existing 49 tests (T01 + Phase 2 T06)
  untouched and still pass.
- **12 new component tests** in `tests/app/loop-detail.test.ts`
  (module surface 2x, header 3x, timeline 3x, sparkline 2x,
  notFound 2x).
- **`bun run build`** clean — 8 routes including the new
  `/loops/[loopId]` (166 B page weight; First Load 105 kB,
  matches the other dynamic server routes — no client island
  added).
- **`bun test`** → 606 pass / 5 fail; the 5 fails are the
  pre-existing Playwright-spec-loaded-by-bun-test issue (same
  shape as the Phase 2 baseline; not caused by this iter).
- **Net delta**: +20 tests, all passing. No regressions in the
  previously-green suites.

## Follow-ups for next iters

- **T3** start dialog plugs into `/loops` page. Will reuse the
  shadcn `<Dialog>` primitive added in Phase 2 T02
  (`dispatch-dialog.tsx`). Schema has `done_when` + `goal` +
  `max_iterations` already validated above by Zod.
- **T4** cancel / approve / reject UI plugs into the detail page
  header card right-slot (the `<Badge>` slot). The page test
  surface (`data-testid="loop-status-badge"`) reserves the spot.
- **Perf-watch**: the count-by-`.all().length` shortcut. If a
  loop ever crosses ~10k iters we'll see it in the slow-route
  log. Switch to `COUNT(*)` aggregate at that point. Not a
  blocker today.
- **Phase 4 SSE multiplex**: when the loops vertical lights up
  on `/api/stream`, the detail page can drop its (zero today,
  future planned) polling and subscribe live.
