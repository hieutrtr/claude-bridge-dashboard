// P3-T9 — pure helpers for the schedule cost-forecast surface. No DB,
// no React, no `document.cookie` access — the tRPC router fetches
// samples from the daemon-vendored `tasks` table and hands the array
// to `forecastSchedule`, which composes the cadence math
// (`runsPerMonthFromCadence`) and the percentile math
// (`summariseCostSamples`) into a single wire envelope.
//
// `runsPerMonthFromCadence` keeps the daemon-side gap explicit:
// uniform-interval cron and `intervalMinutes` collapse to the same
// constant rate; non-uniform cron expressions are counted by walking
// `cron-parser` over a 30-day window. The daemon currently rejects
// non-uniform cron at submit-time (T6 client-side guard), but the
// helper math is correct for the day daemon-side cron support lands —
// no API change needed at that point.
//
// Percentile choice: linear-interpolation between rank floor and ceil
// (the "Type 7" definition — same as `numpy.percentile(..., interpolation
// = "linear")` and R's default). With < 3 samples we surface the
// calibration hint in the UI rather than a high-variance forecast;
// the helper returns a populated p10/p50/p90 for ANY sample size > 0
// so callers can choose what to render.
//
// The 30-day "month" is intentional: deterministic, calendar-agnostic
// (no leap-year + 28/29/30/31-day-month variance), and matches the
// 30-day default lookback window the procedure uses for samples.

import { CronExpressionParser } from "cron-parser";

/**
 * Number of minutes in a 30-day window. Used as the divisor for
 * interval-mode runs/month and the upper bound on `cron-parser`
 * iteration in cron-mode.
 */
export const MINUTES_PER_30_DAYS = 30 * 24 * 60;

/** Hard cap on cron-parser iteration count to avoid runaway loops. */
const CRON_ITERATION_HARD_CAP = 1_000_000;

export interface RunsPerMonthInput {
  intervalMinutes: number | null;
  cronExpr: string | null;
  /**
   * Stable instant for cron-mode counting. Tests inject deterministic
   * values; production captures `new Date()` once at call time.
   */
  now: Date;
}

/**
 * Number of times a schedule fires in a 30-day window.
 *
 * - interval mode: `MINUTES_PER_30_DAYS / intervalMinutes` (rounded down
 *   to an integer; sub-1 intervals like "yearly" return 0).
 * - cron mode (uniform deltas): same as interval mode via
 *   `cronToIntervalMinutes`-equivalent fast path.
 * - cron mode (non-uniform): walk `cron-parser.next()` until the next
 *   fire time falls outside the 30-day window, count the iterations.
 * - both supplied: cron wins.
 * - neither supplied / both invalid: returns 0.
 */
export function runsPerMonthFromCadence(input: RunsPerMonthInput): number {
  const cronCount = countCronFiresInWindow(input.cronExpr, input.now);
  if (cronCount !== null) return cronCount;
  if (input.intervalMinutes !== null && input.intervalMinutes > 0) {
    return Math.floor(MINUTES_PER_30_DAYS / input.intervalMinutes);
  }
  return 0;
}

function countCronFiresInWindow(
  cronExpr: string | null,
  now: Date,
): number | null {
  if (cronExpr === null) return null;
  const trimmed = cronExpr.trim();
  if (trimmed.length === 0) return null;
  let it: ReturnType<typeof CronExpressionParser.parse>;
  try {
    it = CronExpressionParser.parse(trimmed, { currentDate: now });
  } catch {
    return null;
  }
  const windowEndMs = now.getTime() + MINUTES_PER_30_DAYS * 60_000;
  let count = 0;
  for (let i = 0; i < CRON_ITERATION_HARD_CAP; i++) {
    let nextDate: Date;
    try {
      nextDate = it.next().toDate();
    } catch {
      // Iterator exhausted (cron expression has no fire times in the
      // foreseeable future, e.g. a one-shot date in the past).
      break;
    }
    if (nextDate.getTime() > windowEndMs) break;
    count++;
  }
  return count;
}

export interface CostSampleSummary {
  /** Post-filter sample count (drops null / NaN / non-positive). */
  sample: number;
  /** 10th percentile (linear interpolation); null when sample === 0. */
  p10: number | null;
  /** 50th percentile / median; null when sample === 0. */
  p50: number | null;
  /** 90th percentile (linear interpolation); null when sample === 0. */
  p90: number | null;
}

/**
 * Reduce a heterogeneous array of cost samples to its 10/50/90
 * percentiles. Filters out null / NaN / non-positive entries (the
 * daemon writes `cost_usd = 0` for tasks that never billed; including
 * them would skew the median toward 0 and produce an under-estimate).
 *
 * Linear-interpolation percentile (Type 7) — matches numpy default.
 */
export function summariseCostSamples(
  samples: ReadonlyArray<number | null | undefined>,
): CostSampleSummary {
  const cleaned: number[] = [];
  for (const s of samples) {
    if (s === null || s === undefined) continue;
    if (!Number.isFinite(s)) continue;
    if (s <= 0) continue;
    cleaned.push(s);
  }
  if (cleaned.length === 0) {
    return { sample: 0, p10: null, p50: null, p90: null };
  }
  cleaned.sort((a, b) => a - b);
  return {
    sample: cleaned.length,
    p10: percentile(cleaned, 0.1),
    p50: percentile(cleaned, 0.5),
    p90: percentile(cleaned, 0.9),
  };
}

function percentile(sortedAsc: number[], q: number): number {
  // Type-7 (linear): rank = q * (n - 1).
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0]!;
  const rank = q * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

/**
 * Threshold below which the UI surfaces "first run will calibrate
 * forecast" instead of a dollar estimate. Three samples is enough for
 * a stable median (rank floor 0, ceil 2 — covers the full range);
 * fewer than that and p10/p90 collapses onto the same data point.
 */
export const INSUFFICIENT_HISTORY_THRESHOLD = 3;

export interface ForecastInput {
  samples: ReadonlyArray<number | null | undefined>;
  intervalMinutes: number | null;
  cronExpr: string | null;
  now: Date;
}

export interface ScheduleCostForecastShape {
  sample: number;
  runsPerMonth: number;
  avgCostPerRun: number | null;
  p10CostPerRun: number | null;
  p90CostPerRun: number | null;
  monthlyEstimateUsd: number | null;
  monthlyLowUsd: number | null;
  monthlyHighUsd: number | null;
  insufficientHistory: boolean;
  cadenceUnresolved: boolean;
}

/**
 * Single source of truth — composes cadence math + percentile math
 * into the wire envelope the procedure returns. The router uses this
 * directly so the test surface for the math lives entirely in
 * `tests/lib/cost-forecast.test.ts`.
 */
export function forecastSchedule(input: ForecastInput): ScheduleCostForecastShape {
  const runsPerMonth = runsPerMonthFromCadence({
    intervalMinutes: input.intervalMinutes,
    cronExpr: input.cronExpr,
    now: input.now,
  });
  const cadenceUnresolved = runsPerMonth === 0;
  const summary = summariseCostSamples(input.samples);
  const insufficientHistory = summary.sample < INSUFFICIENT_HISTORY_THRESHOLD;

  // Don't multiply when either factor is unknown — surface null and
  // let the UI render the calibration / unresolved message instead.
  const monthlyEstimateUsd =
    !cadenceUnresolved && summary.p50 !== null
      ? summary.p50 * runsPerMonth
      : null;
  const monthlyLowUsd =
    !cadenceUnresolved && summary.p10 !== null
      ? summary.p10 * runsPerMonth
      : null;
  const monthlyHighUsd =
    !cadenceUnresolved && summary.p90 !== null
      ? summary.p90 * runsPerMonth
      : null;

  return {
    sample: summary.sample,
    runsPerMonth,
    avgCostPerRun: summary.p50,
    p10CostPerRun: summary.p10,
    p90CostPerRun: summary.p90,
    monthlyEstimateUsd,
    monthlyLowUsd,
    monthlyHighUsd,
    insufficientHistory,
    cadenceUnresolved,
  };
}

/** Format a USD value to a human-friendly string for the dialog. */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  // Two-decimal precision for "looks like a price" rendering. Daemon's
  // cost_usd column is `REAL` so this is the natural truncation point;
  // values below $0.01 still render as "$0.00" — accepted (a
  // schedule's monthly forecast wouldn't realistically be sub-cent).
  return `$${value.toFixed(2)}`;
}
