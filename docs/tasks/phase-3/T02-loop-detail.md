# P3-T2 — `loops.get` + `/loops/[loopId]` detail page

> Builds on T1's router + page scaffold. Adds the per-loop detail
> view with header card, cumulative-cost sparkline, and iteration
> timeline.

## Scope

- **Router** — extend `src/server/routers/loops.ts` with one new
  query procedure, `get({ loopId })`, returning `LoopDetail | null`.
  Reads from `loops` + `loop_iterations` tables. No MCP, no audit
  (queries not audited per Phase 2 scope decision).
- **DTO** — add `LoopIterationRow` + `LoopDetail` to
  `src/server/dto.ts`. Includes the full `goal` text (the user
  navigated to the detail page so the audit-log privacy precedent
  doesn't apply — same rule that lets `tasks/[id]` show `prompt`).
- **Components** — `src/components/cost-sparkline.tsx` (pure-SVG,
  server-component-friendly cumulative cost path with optional
  budget-cap line + last-point cursor).
- **Page** — `app/loops/[loopId]/page.tsx`. Server-rendered. Header
  card (agent + status badge + goal + done_when + iter & budget
  progress bars), sparkline card, iteration timeline (`<details>` /
  `<summary>` collapsed by default), metadata sidebar.

## Wire shape

```ts
loops.get({ loopId: string }) → LoopDetail | null
```

Where `LoopDetail` extends the columns `LoopListRow` already
exposes with: `goal`, `doneWhen`, `project`, `currentTaskId`,
`channel`, `channelChatId`, `planEnabled`, `passThreshold`,
`consecutivePasses`, `consecutiveFailures`, plus
`iterations: LoopIterationRow[]` and the truncation pair
`{ iterationsTruncated, totalIterations }`.

`iterations` is the most-recent `LOOP_ITERATIONS_LIMIT = 100` rows
returned in **ascending** `iteration_num` order so the sparkline
reads left-to-right naturally. Implementation pulls DESC + reverses
client-side; the alternative ASC query has no LIMIT in the right
direction without `ROW_NUMBER()` gymnastics.

## Acceptance

1. `loops.get({ loopId: "ghost" })` over a missing row returns `null`.
2. `loops.get` projects every detail-page column. Goal text DOES
   appear on the wire (intentional — see §c).
3. Iterations come back ascending by `iteration_num` regardless of
   insert order.
4. With ≤ 100 iterations: `iterationsTruncated=false`,
   `totalIterations` matches the row count.
5. With > 100 iterations: `iterations` carries the most-recent 100
   (the ASC sequence ending at `currentIteration`),
   `iterationsTruncated=true`, `totalIterations=N`.
6. `/loops/[loopId]` page renders header, sparkline, timeline,
   sidebar. 50-iter loop renders without lag.
7. Iteration `<details>` rows collapsed by default; expanding one
   doesn't expand the others (per-iter state via the native
   `<details>` element — no client component needed).
8. Each iter with a `task_id` cross-links to `/tasks/[task_id]`.
9. Sparkline renders one polyline + last-point cursor + (optional)
   budget-cap dashed line; falls back to an empty placeholder when
   no iterations exist.
10. Unknown / empty / over-128-char `loopId` calls Next's `notFound()`.

## Tests

| File                                  | Coverage                                               |
|---------------------------------------|--------------------------------------------------------|
| `tests/server/loops-router.test.ts`   | 8 new cases extending the existing T1 file: unknown id, happy path with iteration ordering, empty iterations, nullable column projection, 100-row truncation, input validation (empty + over-cap loopId). |
| `tests/app/loop-detail.test.ts` (new) | 12 cases: module surface (no POST/PUT/PATCH/DELETE), header (status badge, budget formatting, waiting-approval state), iteration timeline (rows, empty state, truncation banner), sparkline (data-points attr, empty state), notFound() on unknown / empty id. |

Both files mirror the T1 fixture pattern: tmp on-disk SQLite,
seeded via raw `INSERT`, rendered through
`react-dom/server.renderToStaticMarkup`. The sparkline assertions
key off `data-testid` / `data-points` attributes so the test stays
markup-stable.

## Out of scope (handled in later iters)

- **Cancel button + approve / reject gate** — lands in P3-T4. The
  detail page header has space allocated (the `<Badge>` slot in the
  top-right + the sidebar) so T4's diff is additive.
- **Live updates** — page is statically rendered today; T2 polls
  zero times. Phase 4 multiplexes loops onto `/api/stream`. The
  acceptance text was edited verbatim from the v1 plan to reflect
  this scope deferral.
- **Goal-text privacy on the wire** — list payload (T1) hides
  `goal`; detail payload (T2) shows it. Reviewed in T02-review.md
  §1 — consistent with `tasks.get` showing `prompt` while the
  audit log never echoes either.

## Files touched

- `src/server/dto.ts` — `LoopDetail`, `LoopIterationRow` interfaces.
- `src/server/routers/loops.ts` — `get` query + `GetInput` +
  `LOOP_ITERATIONS_LIMIT` + `DETAIL_DTO_SELECTION` +
  `ITER_DTO_SELECTION`. Imports `loopIterations` from schema.
- `src/components/cost-sparkline.tsx` — new pure-SVG cumulative-cost
  sparkline.
- `app/loops/[loopId]/page.tsx` — new dynamic route, server-rendered.
- `tests/server/loops-router.test.ts` — extended SCHEMA_DDL with
  `loop_iterations` + new `seedIter` helper + 4 new describe blocks.
- `tests/app/loop-detail.test.ts` — new component test file.

## Risk / lessons

- **Risk: Low**. Read-only query; the iteration cap is unit-tested
  end-to-end (seed 150, expect 100 returned with the expected
  start/end iteration_num pair).
- **Lesson — "DESC + reverse" vs ASC + ROW_NUMBER**: SQLite has no
  ergonomic "tail N" syntax. The DESC + reverse pattern keeps the
  query plan trivial (one index scan on `idx_loop_iterations_loop`)
  and the test easy to write. Documented inline in the procedure
  body so a future reader doesn't try to "fix" it.
- **Lesson — privacy split between list and detail**: the audit
  privacy rule is "never echo user-supplied free-text into
  `audit_log.payload_json`". It does NOT mean "never show goal in
  any UI surface". The detail page is the right place to show it
  because the user explicitly navigated to a known loop_id.
- **Lesson — server component sparkline**: dropping Recharts for a
  hand-rolled SVG path lets the page stay a server component end
  to end (no client island, no boundary roundtrip). The trade-off
  is no interactive tooltip — for a sparkline this is fine; the
  iteration `<details>` rows already give per-iter inspection.
