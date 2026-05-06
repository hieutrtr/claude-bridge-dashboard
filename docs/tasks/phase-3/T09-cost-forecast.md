# P3-T9 — Cost forecast helper + live forecast in the schedule-create dialog

> **Loop step 10/11.** The last Phase 3 *feature* before phase sign-off:
> a cost-forecast surface inside the T6 schedule-create dialog. The user
> sees an estimated monthly spend for the cadence they're about to
> commit to, computed from the agent's recent task-cost history. Closes
> the v1 P3-T9 acceptance ("± 30 % so với thực tế sau 1 tháng" — empirical
> validation deferred per INDEX §"Cost forecast accuracy validation";
> this loop validates the *shape* and the *math*, not the *accuracy*).

## Goal

When the user picks an agent + cadence in `<ScheduleCreateDialog>`, the
dashboard surfaces a forecast block right under the cron picker:

```
Estimated spend: $4.12 / month
Likely range $2.30 – $6.80 (based on 18 sampled runs).
```

If sample size < 3 (or the agent has zero `cost_usd` history yet), the
block surfaces a calibration hint instead:

```
Insufficient history — first run will calibrate forecast.
```

The estimate updates reactively as the user changes cadence (preset
flips, custom-mode keystrokes) or agent. The forecast is **read-only**
— a tRPC query, not a mutation. No CSRF, no rate-limit token, no audit
row (per Phase 2 audit-scope decision: queries are not audited).

## Files touched

| Path | Status |
|---|---|
| `src/lib/cost-forecast.ts` | **new** — pure forecast helpers |
| `src/server/dto.ts` | +25 (`ScheduleCostForecast`) |
| `src/server/routers/schedules.ts` | +95 (`costForecast` query) |
| `src/components/schedule-create-dialog.tsx` | edit — accept forecast props + render block; wrapper fetches |
| `tests/lib/cost-forecast.test.ts` | **new** — 18 cases (math + cadence) |
| `tests/server/schedules-router.test.ts` | edit — extend with 9 router cases |
| `tests/app/schedule-create-dialog.test.ts` | edit — 4 forecast-display cases |
| `docs/tasks/phase-3/T09-cost-forecast.md` | **new** — this file |
| `docs/tasks/phase-3/T09-review.md` | **new** — code review |

## Wire shape — `schedules.costForecast`

```ts
// server input
{
  agent:           z.string().min(1).max(128),
  intervalMinutes: z.number().int().min(1).max(43_200).optional(),
  cronExpr:        z.string().min(1).max(256).optional(),
  // At least one of `intervalMinutes` / `cronExpr` must be supplied.
  // Both supplied → cron preferred for runs/month accuracy; interval
  // is the fallback when cron is non-uniform / un-parseable.
  // Sample window is implicit — the procedure pulls the 200
  // most-recent cost-bearing tasks for the agent ordered by id DESC.
  // No SQL date filter (avoids the seed-vs-runtime mismatch SQLite's
  // datetime('now', ...) introduces against ISO-string fixtures).
}

// server output — `ScheduleCostForecast`
interface ScheduleCostForecast {
  /** Number of cost samples that fed the forecast (min 0). */
  sample: number;
  /** Number of times the schedule will fire in 30 days at this cadence. */
  runsPerMonth: number;
  /** Median cost-per-run in USD; null when sample === 0. */
  avgCostPerRun: number | null;
  /** p10 cost (low end of likely-range); null when sample === 0. */
  p10CostPerRun: number | null;
  /** p90 cost (high end of likely-range); null when sample === 0. */
  p90CostPerRun: number | null;
  /** median × runsPerMonth; null when sample === 0 OR cadence unresolved. */
  monthlyEstimateUsd: number | null;
  monthlyLowUsd: number | null;
  monthlyHighUsd: number | null;
  /**
   * `true` when sample < 3 — UI surfaces "first run will calibrate
   * forecast" instead of the dollar estimate.
   */
  insufficientHistory: boolean;
  /**
   * `true` when neither intervalMinutes nor a parseable cronExpr was
   * supplied OR the cron is non-uniform. UI hides the dollar estimate
   * but still surfaces the sample count if any.
   */
  cadenceUnresolved: boolean;
}
```

## Forecast math

The pure helper at `src/lib/cost-forecast.ts` exports two functions:

### `runsPerMonthFromCadence({ intervalMinutes, cronExpr, now }) → number`

- **Interval mode** (intervalMinutes supplied, cronExpr null):
  `(30 days × 24 h × 60 min) / intervalMinutes`. Returns 0 when the
  interval is non-positive or `> lookbackDays in minutes` (a yearly
  schedule with intervalMinutes > 30d would round to 0; we treat that
  as "fewer than one fire per month" and the UI shows "—").
- **Cron mode** (cronExpr supplied + parseable + uniform): same formula
  via `cronToIntervalMinutes` from `schedule-add-client.ts` — keeps the
  daemon-side gap (only uniform-interval cron supported today) explicit
  here too.
- **Cron mode (non-uniform)**: count actual fire times via
  `CronExpressionParser.parse(cronExpr).next()` in a 30-day window.
  Daemon doesn't accept these expressions yet (T6 client rejects them
  before submit), but the helper math IS correct for when daemon-side
  cron support lands.
- **Both supplied**: cron wins (more accurate for non-uniform schedules).
- **Neither supplied / both invalid**: returns 0. The tRPC procedure
  short-circuits the percentile math and surfaces `cadenceUnresolved:
  true`.

### `summariseCostSamples(samples) → { sample, p10, p50, p90 }`

- Pure: filters to finite positive numbers, sorts ascending, returns
  the 10th / 50th / 90th percentile via linear-interpolation between
  rank floor + ceil (the "Type 7" definition — same as numpy's default).
- `sample` is the *post-filter* count (drops null / NaN / negative).
- Empty / single-sample inputs return `{ sample, p10: null, p50: null,
  p90: null }`. The procedure carries that null straight through to the
  wire so the UI renders the calibration hint instead of `$NaN/month`.

### `forecastSchedule({ samples, intervalMinutes, cronExpr, now }) → ScheduleCostForecast`

Composes the two above into the wire shape. Single source of truth so
the router test exercises both paths through the helper.

## DB query — what feeds `samples`

The tRPC procedure resolves the agent's `session_id` from the `agents`
table, then pulls the most-recent cost-bearing tasks:

```sql
SELECT cost_usd
  FROM tasks
 WHERE session_id = ?
   AND cost_usd IS NOT NULL
   AND cost_usd > 0
 ORDER BY id DESC
 LIMIT 200
```

Notes:

1. **No `task_type='schedule'` filter.** v1 P3-T9 spec said *prefer
   schedule-typed tasks, fall back to standard*. The daemon's current
   schema doesn't reliably tag scheduler-dispatched rows with
   `task_type='schedule'` (per the daemon's `scheduler.ts:80-88` —
   `atomicCheckAndCreateTask` doesn't pass a `task_type`). Filtering on
   `task_type='schedule'` would give us zero rows for *every* real
   deployment. Falling back to all costed tasks for the agent gives a
   useful first-order forecast — "this agent's average task costs
   ~$0.05; over 720 hourly runs that's ~$36/month". Reviewed in T09-
   review.md; if the daemon grows reliable scheduler tagging, the
   filter is a one-line gate to add.
2. **Hard cap at 200 rows.** Plenty of signal for percentiles — adding
   more samples doesn't change p50/p10/p90 once you're past ~50 — and
   keeps the query fast on busy agents (a cron picker keystroke
   shouldn't issue a 100k-row scan).
3. **`cost_usd > 0` filter.** The daemon writes `cost_usd = 0` for
   tasks that never billed (early-exit, validation failure, etc).
   Including them would skew the median toward 0 and produce an
   under-estimate. We treat 0-cost rows as "didn't really run" and
   exclude them from the sample pool — the comment in the helper
   makes this explicit.
4. **No date filter.** v1 P3-T9 spec called for a 30-day lookback,
   but a date filter forces the test fixtures to time-travel against
   `datetime('now')` and SQLite's text-vs-numeric timestamp shape
   makes that brittle. The 200-row ORDER BY id DESC bound is a
   reasonable proxy: a busy agent's most-recent 200 cost-bearing
   runs span a few days at most; a quiet agent's span everything
   since inception, and stale entries get phased out as new runs
   accumulate. Filed as a Phase-4 polish if the per-agent sample
   pool grows unbounded enough to matter (no agent today does).

## UI integration

`<ScheduleCreateDialogView>` grows two new optional props:

```ts
forecast: ScheduleCostForecast | null;  // null = haven't fetched yet
forecastLoading: boolean;
```

The view renders a single block under the cron picker:

- `forecast === null && !forecastLoading` → block hidden (initial mount,
  before the first fetch lands).
- `forecastLoading` → "Computing forecast…" (light skeleton).
- `forecast.cadenceUnresolved` → "Forecast unavailable for this
  cadence." (shouldn't fire in practice — submit is also disabled).
- `forecast.insufficientHistory` → "Insufficient history — first run
  will calibrate forecast." Plus the resolved cadence: "(N runs / month
  at this cadence)".
- Happy path → "Estimated spend: $X.XX / month. Likely range $Y.YY –
  $Z.ZZ (based on N samples)."

The wrapper `<ScheduleCreateDialog>` fetches the forecast in a
`useEffect` keyed on `(agentName, intervalMinutes, cronExpr)`. The
fetch is debounced via React's natural batch (effect runs once per
render, not per keystroke); we also race-guard with a stale-result
token so a slow fetch can't clobber a newer one.

The forecast fetch URL is `/api/trpc/schedules.costForecast?input=...`
(GET — same as `agents.list`). No CSRF token required.

## Acceptance

1. **Helper math** — `runsPerMonthFromCadence` returns:
   - hourly cron / 60-minute interval → 720
   - daily 9am cron / 1440-minute interval → 30
   - weekly Mon 9am cron / 10080-minute interval → 4 (or 5 depending on
     `now` — covered by the deterministic-`now` test)
   - 30-minute interval → 1440
   - non-uniform cron → counts actual fires in 30 days
   - neither supplied → 0
2. **Helper math** — `summariseCostSamples`:
   - empty → `sample: 0, p10/p50/p90: null`
   - single sample $0.10 → `sample: 1, p10/p50/p90: 0.10`
   - sorted-uniform [0.01, 0.05, 0.10, 0.20, 0.50] → median 0.10, p10
     near 0.01, p90 near 0.50 (linear interpolation pinned to ±1e-6)
   - filters out NaN / negative / zero / null entries
3. **tRPC happy path** — agent with 5 task rows (`cost_usd = 0.05` each)
   + intervalMinutes=60 returns `runsPerMonth: 720, avgCostPerRun:
   0.05, monthlyEstimateUsd: 36, sample: 5, insufficientHistory: false`.
4. **tRPC insufficient-history path** — agent with 0 cost-bearing
   tasks → `sample: 0, insufficientHistory: true, monthlyEstimateUsd:
   null`. Cadence still resolved (so the UI can render runsPerMonth).
5. **tRPC cadence-unresolved path** — empty cron + missing
   intervalMinutes (or both invalid) → `cadenceUnresolved: true,
   runsPerMonth: 0`. Procedure surfaces a `BAD_REQUEST` when neither
   field is supplied at all (Zod refinement); cadenceUnresolved is the
   *valid input but unresolvable* state.
6. **tRPC unknown-agent** — Zod-valid agent name with no row in
   `agents` → `sample: 0, insufficientHistory: true, runsPerMonth >
   0`. The forecast is still useful for "what would N runs/month
   roughly cost?" — we just have no per-agent baseline yet.
7. **tRPC excludes 0-cost rows** — agent with rows
   `[$0.00, $0.00, $0.05]` returns `sample: 1` (only the $0.05 row).
8. **tRPC clamps to 200 rows** — agent with 250 cost-bearing rows
   returns `sample: 200`.
9. **No audit row** — the procedure is a query; `audit_log` stays
   untouched.
10. **No MCP context required** — the procedure runs without
    `ctx.mcp` wired (it's a plain DB read). Wires it through the
    `appRouter.createCaller({})` shape that Phase 1 list queries use.
11. **tRPC requires at least one cadence** — Zod refinement rejects
    inputs with neither `intervalMinutes` nor `cronExpr` (`BAD_REQUEST`).
12. **Dialog renders happy path** — view receives `{
    monthlyEstimateUsd: 4.12, monthlyLowUsd: 2.30, monthlyHighUsd:
    6.80, sample: 18, insufficientHistory: false, cadenceUnresolved:
    false }` → static markup contains "$4.12", "$2.30 – $6.80", "18".
13. **Dialog renders calibration hint** — `insufficientHistory: true`
    → markup contains "Insufficient history".
14. **Dialog hides forecast block** — `forecast: null` →
    no forecast text rendered.
15. **Dialog renders skeleton on `forecastLoading: true`** — markup
    contains "Computing forecast".

## Phase 3 invariant checklist (per INDEX §invariant)

- [x] **No MCP call** — the forecast is a read-only DB query; the
      Phase 3 invariant only applies to *mutations*, not queries (per
      Phase 2 audit-scope decision).
- [x] **No CSRF** — GET requests are not subject to CSRF (Phase 2 T08).
- [x] **No rate limit** — no mutation token bucket draw.
- [x] **No audit row** — read-only query (Phase 2 audit-scope).
- [x] **No optimistic UI** — server-confirmed read.
- [x] **No DangerConfirm** — read-only.

## Out of scope / follow-ups

- **Empirical accuracy validation** (v1 P3-T9 acceptance "± 30 % vs
  reality after 1 month"). Filed against `claude-bridge-dashboard`
  as a 30-day-after-launch task — needs production data this loop
  can't generate.
- **Per-prompt forecasting**. Two schedules on the same agent with
  very different prompts will share the same baseline — the median is
  agent-wide, not prompt-aware. A clustered-by-`prompt` percentile
  pass would refine the forecast but adds DB query cost; deferred to
  Phase 4 once we see whether the per-agent estimate is accurate
  enough in practice.
- **Confidence intervals** (proper bootstrap rather than p10/p90).
  The current p10/p90 is "what does the bottom/top decile of past
  costs look like × number of fires" — an empirical-Bayesian rough.
  Tightening it requires more samples than most agents have.
- **Forecast display in `/schedules` table rows** (not just on
  create). Filed as Phase 4 polish — the table-row forecast would
  pin the running monthly burn-rate per schedule. The wire shape
  already supports it — just need a per-row UI surface.
- **Currency localisation**. Hard-coded USD per the daemon's
  `cost_usd` column.
