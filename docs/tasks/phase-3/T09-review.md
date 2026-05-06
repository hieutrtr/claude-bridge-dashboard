# P3-T9 — review

> **Read after** `T09-cost-forecast.md` (the spec) — this file
> documents the *decisions* I'd want a reviewer to push on.

## What landed

- Pure helper `src/lib/cost-forecast.ts` exporting
  `runsPerMonthFromCadence`, `summariseCostSamples`, `forecastSchedule`,
  `formatUsd`. No DB / React / fetch. Deterministic given an injected
  `now`.
- Read-only tRPC query `schedules.costForecast` in
  `src/server/routers/schedules.ts` — pulls the agent's recent
  cost-bearing tasks (top 200 by id DESC) and hands them to
  `forecastSchedule`. Unknown agent / zero history both surface as
  `insufficientHistory: true` with `runsPerMonth` still computed.
- Wire DTO `ScheduleCostForecast` in `src/server/dto.ts` — every
  monthly USD field is nullable; `insufficientHistory` and
  `cadenceUnresolved` are the two render-gates the dialog reads.
- Dialog wiring — `<ScheduleCreateDialogView>` grew two new props
  (`forecast`, `forecastLoading`) and renders a small inline block
  under the cron picker. `<ScheduleCreateDialog>` fires the fetch in a
  `useEffect` keyed on `(open, agentName, intervalMinutes, cronExpr,
  cronValid)` with a race-guard token so a slow round-trip can't
  clobber a newer one.
- Tests: 28 lib cases + 14 router cases + 5 component view cases.
  Suite-wide: **946 pass / 0 fail / 4483 expect** (was 866 before this
  iter). Build: `/schedules` First Load JS **41.2 → 43.4 kB** (cron
  picker + dialog already accounted for the cron-parser bundle; the
  forecast block + fetch helper add ~2 kB).

## Decision log

### `lookbackDays` dropped from the input

The spec originally promised a `lookbackDays` parameter (default 30).
The first cut routed it through `WHERE created_at >= datetime('now',
'-' || ? || ' days')`, but that ran straight into the SQLite
text-vs-numeric timestamp problem: the daemon writes ISO 8601 with `T`
separators (`'2026-05-06T00:00:00.000Z'`), `datetime('now', ...)` emits
the space-separator form (`'2026-05-06 12:34:56'`), and lexicographic
comparison between the two is well-defined but surprising. Test
fixtures that seed absolute timestamps would either have to pin the
test-runtime clock or generate timestamps relative to `Date.now()` —
both fragile.

**Decision**: drop the date filter, keep the 200-row cap, ORDER BY id
DESC. The 200-row bound is the operative rate-limit on the sample
pool. Spec + the helper comments both make this explicit. Filed as a
Phase-4 polish if the per-agent sample pool grows unbounded enough to
matter.

### Sample filter — `cost_usd > 0`, not just `IS NOT NULL`

The daemon writes `cost_usd = 0` for tasks that exited before billing
(early-exit, validation failure, dispatch never started, etc.).
Including those rows would skew the median toward 0 and produce a
systematic under-estimate. Two test cases pin this:

- `excludes 0-cost rows from the sample pool` — three rows
  `[$0, $0, $0.05]` → `sample: 1`.
- `excludes rows where cost_usd IS NULL` — two NULL rows + one $0.10
  → `sample: 1`.

A reviewer might push back: "but a 0-cost early-exit is a real run
the schedule will still trigger; the user pays the runtime cost even
if billing was zero." I'd argue that for *forecasting* the user wants
to know "what does a successful run cost?" not "what does the average
of {success, fail-fast} cost?" — the dollar number on the page is the
forecast for billed months.

### No `task_type='schedule'` filter

v1 P3-T9 spec said *prefer schedule-typed tasks, fall back to standard
tasks*. The daemon's current `atomicCheckAndCreateTask` flow doesn't
reliably tag scheduler-dispatched rows with `task_type='schedule'` —
filtering on it would give us zero rows for *every* real deployment.
Falling back unconditionally to all costed tasks for the agent gives
a useful first-order forecast: this agent's workload-mix is probably
similar across schedule-fired and ad-hoc dispatches, and the median is
robust to outliers anyway.

If the daemon grows reliable scheduler tagging (filed against
`claude-bridge` as a Phase-4 entry note), the filter is a one-line
gate: `eq(tasks.taskType, "schedule")` in the `where` clause.

### Threshold for `insufficientHistory` is hard-coded at 3

Below 3 samples the p10/p90 collapses (rank floor 0, ceil 0 or 0/1
depending on size — degenerate). Three samples give a meaningful
median + non-zero spread. Empirically this matches what other tools
do for early-stage cost forecasts (e.g. AWS Cost Explorer surfaces
"insufficient data" for < 3 days of history at any granularity).

The threshold is exported as `INSUFFICIENT_HISTORY_THRESHOLD` so it's
discoverable; if a deployment's user feedback says "show me
estimates earlier" we can drop it to 2 with a one-line edit.

### Linear-interpolation percentile (Type 7), not nearest-rank

We use the rank-floor / rank-ceil interpolation with linear weights
(numpy default; R default; `quantile(..., type = 7)` in R). The
alternative — nearest-rank — would give a less smooth p10/p90 step
function as samples come and go. For the dialog's "likely range $Y –
$Z" display, the linear version is friendlier (small sample changes
don't flip the dollar number by 30 %).

### Race-guard token, not AbortController

The dialog effect uses a numeric `forecastTokenRef.current` and
discards out-of-order responses. AbortController would be cleaner but:
(a) the cron picker emits `onChange` synchronously on every render
which makes effect dependencies churn, and (b) the request is small
(~80 bytes JSON) so cancelling is barely cheaper than letting it
land. Decision: token wins for code clarity; revisit if forecast
fetches show up as a perf problem.

### Forecast block hides on `forecast === null` initial render

The view doesn't render *anything* in the forecast slot until the
first fetch lands. This avoids a layout shift when the block appears,
but means the user sees the cron picker without forecast text for
~150 ms after first opening the dialog. Acceptable — the dialog's
"Loading agents…" state already trains the user to expect a brief
asynchronous fill. If layout shift becomes a UX complaint, we can
reserve space with a fixed-height skeleton (a one-line CSS edit).

### Why the helper accepts the *raw cron* (not the picker's
`evaluateCron` result)

The cron picker already rejects non-uniform expressions (T6 client-side
guard — daemon doesn't accept them). The forecast helper still walks
`cron-parser` independently for correctness — we don't trust the picker
to have already vetted the expression, since the procedure is exposed
on the wire and a hostile client could submit anything. Defence-in-
depth, same rule as the server-side Zod re-validation of every
mutation input.

## Things I'd file but didn't fix here

1. **Empirical accuracy validation.** v1 P3-T9 said "± 30 % vs reality
   after 1 month" — that's a 30-day-after-launch task; this loop only
   validates the *shape* and the *math*. Pinned in the spec's
   acceptance section so the gap is visible.
2. **Per-prompt forecasting.** Two schedules on the same agent with
   wildly different prompts (e.g. "summarize PR" vs "run full test
   suite") share the same baseline. A clustered-by-prompt percentile
   pass would refine the forecast but adds DB complexity. Filed for
   Phase 4.
3. **Forecast in `/schedules` table rows.** Right now it only renders
   on schedule-create. Surfacing the running monthly-burn-rate per
   schedule on the index page would close a "what does this active
   schedule cost me?" loop. Wire shape already supports it.
4. **Currency localisation.** Hard-coded USD per the daemon's column
   name.
5. **`schedules.runs` cost rollup.** The drawer (T8) already carries
   `costUsd` per run; a "this schedule has spent $X this month"
   header would be a useful complement to the *forecast* on the
   create page — Phase 4 polish.

## Phase 3 invariants — re-verified

- [x] **No MCP** — query, no tool call.
- [x] **No CSRF** — GET (tRPC v11 query path).
- [x] **No rate limit** — no mutation token bucket.
- [x] **No audit row** — read-only.
- [x] **No optimistic UI** — server-confirmed read.
- [x] **No DangerConfirm** — read-only.

## Coverage delta

| Surface | Before | After | Δ |
|---|---:|---:|---:|
| `tests/lib/*.test.ts` | 11 files | 12 files | +1 (cost-forecast) |
| `tests/server/schedules-router.test.ts` | 65 cases | 79 cases | +14 |
| `tests/app/schedule-create-dialog.test.ts` | 13 cases | 18 cases | +5 |
| Suite total | 866 / 0 fail | 946 / 0 fail | +80 |

`/schedules` route First Load JS: 41.2 → 43.4 kB (+2.2 kB — forecast
block + fetch helper).

## Phase 3 → Phase test (next loop step)

After this commit, the `phase-3` branch has all 9 task commits
(T1..T9). Step 11 is the phase test + sign-off:

- E2E Playwright: `loop-start-cancel`, `schedule-create`,
  `schedule-pause-delete` — three new specs (5 → 8 total).
- `bun test` + `bun run build` — already green here.
- `docs/tasks/phase-3/PHASE-BROWSER-TEST.md` — 9-step manual.
- `docs/tasks/phase-3/PHASE-3-COMPLETE.md` — sign-off + GO/CAVEAT/NO-GO.
