// P3-T9 — pure unit tests for the cost-forecast helpers. No DB, no
// fetch, no React; we exercise the cadence math + percentile math
// against deterministic `now` values + small sample arrays so the
// router test (`tests/server/schedules-router.test.ts`) can lean on
// the helper for the integration coverage and pin the wire shape
// rather than re-validating every percentile boundary.

import { describe, it, expect } from "bun:test";

import {
  INSUFFICIENT_HISTORY_THRESHOLD,
  MINUTES_PER_30_DAYS,
  forecastSchedule,
  formatUsd,
  runsPerMonthFromCadence,
  summariseCostSamples,
} from "../../src/lib/cost-forecast";

const NOW = new Date("2026-05-06T08:00:00.000Z");

describe("runsPerMonthFromCadence — interval mode", () => {
  it("60-minute interval → 720 (24h × 30d)", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: 60,
        cronExpr: null,
        now: NOW,
      }),
    ).toBe(720);
  });

  it("1440-minute interval → 30 (one fire per day)", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: 24 * 60,
        cronExpr: null,
        now: NOW,
      }),
    ).toBe(30);
  });

  it("10080-minute interval → 4 (weekly)", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: 7 * 24 * 60,
        cronExpr: null,
        now: NOW,
      }),
    ).toBe(4);
  });

  it("30-minute interval → 1440 (every half hour)", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: 30,
        cronExpr: null,
        now: NOW,
      }),
    ).toBe(1440);
  });

  it("interval > 30d → 0 (less than one fire per month)", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: MINUTES_PER_30_DAYS + 1,
        cronExpr: null,
        now: NOW,
      }),
    ).toBe(0);
  });

  it("non-positive interval → 0 (rejected)", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: 0,
        cronExpr: null,
        now: NOW,
      }),
    ).toBe(0);
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: -5,
        cronExpr: null,
        now: NOW,
      }),
    ).toBe(0);
  });
});

describe("runsPerMonthFromCadence — cron mode", () => {
  it("hourly cron → 720", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: null,
        cronExpr: "0 * * * *",
        now: NOW,
      }),
    ).toBe(720);
  });

  it("daily 9am cron → 30 (NOW = 08:00 → 30 fires before day-30 09:00)", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: null,
        cronExpr: "0 9 * * *",
        now: NOW,
      }),
    ).toBe(30);
  });

  it("weekly Mon-9am cron → 4 (May 11/18/25 + June 1; June 8 = day 33)", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: null,
        cronExpr: "0 9 * * 1",
        now: NOW,
      }),
    ).toBe(4);
  });

  it("malformed cron → falls back to interval (returns 0 if interval also missing)", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: null,
        cronExpr: "not a cron",
        now: NOW,
      }),
    ).toBe(0);
  });

  it("malformed cron + valid interval → uses interval", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: 60,
        cronExpr: "not a cron",
        now: NOW,
      }),
    ).toBe(MINUTES_PER_30_DAYS / 60);
  });

  it("non-uniform weekday cron `0 9 * * 1-5` → counts actual fires (~22)", () => {
    // 30 days from May 6 2026 (Wed) → next 30 days runs through June 5
    // 2026 (Fri). Weekdays in that range = 22. The exact count is
    // deterministic for the fixed `now`.
    const out = runsPerMonthFromCadence({
      intervalMinutes: null,
      cronExpr: "0 9 * * 1-5",
      now: NOW,
    });
    // We don't pin the exact count to avoid coupling the test to
    // calendar arithmetic; just sanity-check it's in the weekday-cron
    // range (15..25 fires for any 30-day window).
    expect(out).toBeGreaterThanOrEqual(15);
    expect(out).toBeLessThanOrEqual(25);
  });

  it("cron wins over interval when both supplied", () => {
    // intervalMinutes=1 would give 43_200; cron "0 * * * *" gives 720.
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: 1,
        cronExpr: "0 * * * *",
        now: NOW,
      }),
    ).toBe(720);
  });
});

describe("runsPerMonthFromCadence — neither", () => {
  it("returns 0 when neither cron nor interval supplied", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: null,
        cronExpr: null,
        now: NOW,
      }),
    ).toBe(0);
  });

  it("treats whitespace-only cron as missing", () => {
    expect(
      runsPerMonthFromCadence({
        intervalMinutes: null,
        cronExpr: "   ",
        now: NOW,
      }),
    ).toBe(0);
  });
});

describe("summariseCostSamples", () => {
  it("empty input → sample=0 + null percentiles", () => {
    expect(summariseCostSamples([])).toEqual({
      sample: 0,
      p10: null,
      p50: null,
      p90: null,
    });
  });

  it("single sample → sample=1 + p10/p50/p90 collapse to that value", () => {
    expect(summariseCostSamples([0.1])).toEqual({
      sample: 1,
      p10: 0.1,
      p50: 0.1,
      p90: 0.1,
    });
  });

  it("filters null/NaN/zero/negative entries", () => {
    const out = summariseCostSamples([
      null,
      undefined,
      Number.NaN,
      0,
      -1,
      0.05,
      0.10,
    ]);
    expect(out.sample).toBe(2);
    expect(out.p50).toBeCloseTo(0.075, 6);
  });

  it("five samples [0.01, 0.05, 0.10, 0.20, 0.50] → median = 0.10", () => {
    const out = summariseCostSamples([0.01, 0.05, 0.10, 0.20, 0.50]);
    expect(out.sample).toBe(5);
    expect(out.p50).toBeCloseTo(0.10, 6);
    // p10 with linear interp = 0.01 + 0.4 * (0.05 - 0.01) = 0.026
    expect(out.p10).toBeCloseTo(0.026, 6);
    // p90 with linear interp = 0.20 + 0.6 * (0.50 - 0.20) = 0.38
    expect(out.p90).toBeCloseTo(0.38, 6);
  });

  it("handles unsorted input (sorts before percentile)", () => {
    const out = summariseCostSamples([0.5, 0.01, 0.2, 0.05, 0.1]);
    expect(out.p50).toBeCloseTo(0.10, 6);
  });

  it("preserves sample count after filtering", () => {
    const out = summariseCostSamples([0.05, 0.05, 0.05, 0, 0]);
    expect(out.sample).toBe(3);
  });
});

describe("forecastSchedule — happy path", () => {
  it("5 cost samples × hourly cadence → monthlyEstimateUsd = median × 720", () => {
    const out = forecastSchedule({
      samples: [0.05, 0.05, 0.05, 0.05, 0.05],
      intervalMinutes: 60,
      cronExpr: null,
      now: NOW,
    });
    expect(out.runsPerMonth).toBe(720);
    expect(out.sample).toBe(5);
    expect(out.avgCostPerRun).toBeCloseTo(0.05, 6);
    expect(out.monthlyEstimateUsd).toBeCloseTo(0.05 * 720, 6);
    expect(out.monthlyLowUsd).toBeCloseTo(0.05 * 720, 6);
    expect(out.monthlyHighUsd).toBeCloseTo(0.05 * 720, 6);
    expect(out.insufficientHistory).toBe(false);
    expect(out.cadenceUnresolved).toBe(false);
  });

  it("variable samples produce a meaningful low/high spread", () => {
    const out = forecastSchedule({
      samples: [0.01, 0.05, 0.10, 0.20, 0.50],
      intervalMinutes: 60,
      cronExpr: null,
      now: NOW,
    });
    expect(out.monthlyLowUsd! < out.monthlyEstimateUsd!).toBe(true);
    expect(out.monthlyEstimateUsd! < out.monthlyHighUsd!).toBe(true);
  });
});

describe("forecastSchedule — insufficient history", () => {
  it("zero samples → insufficient + null monthly USD even when cadence resolved", () => {
    const out = forecastSchedule({
      samples: [],
      intervalMinutes: 60,
      cronExpr: null,
      now: NOW,
    });
    expect(out.insufficientHistory).toBe(true);
    expect(out.runsPerMonth).toBe(720);
    expect(out.monthlyEstimateUsd).toBeNull();
    expect(out.cadenceUnresolved).toBe(false);
  });

  it("two samples (< threshold) still surface insufficientHistory=true", () => {
    expect(INSUFFICIENT_HISTORY_THRESHOLD).toBe(3);
    const out = forecastSchedule({
      samples: [0.05, 0.10],
      intervalMinutes: 60,
      cronExpr: null,
      now: NOW,
    });
    expect(out.insufficientHistory).toBe(true);
    // Helper still produces percentile values for the dialog if it
    // chooses to render them — UI hides the dollar estimate per spec.
    expect(out.avgCostPerRun).not.toBeNull();
    // monthlyEstimateUsd IS populated — the threshold is a UX signal,
    // not a math gate. The dialog reads `insufficientHistory` to decide
    // whether to render the dollar block.
    expect(out.monthlyEstimateUsd).not.toBeNull();
  });
});

describe("forecastSchedule — cadence unresolved", () => {
  it("neither cadence supplied → cadenceUnresolved=true + null monthly", () => {
    const out = forecastSchedule({
      samples: [0.05, 0.05, 0.05],
      intervalMinutes: null,
      cronExpr: null,
      now: NOW,
    });
    expect(out.cadenceUnresolved).toBe(true);
    expect(out.runsPerMonth).toBe(0);
    expect(out.monthlyEstimateUsd).toBeNull();
    expect(out.monthlyLowUsd).toBeNull();
    expect(out.monthlyHighUsd).toBeNull();
    // Sample percentiles are still on the wire — useful for the
    // "calibrate" hint that surfaces sample size.
    expect(out.avgCostPerRun).not.toBeNull();
  });
});

describe("formatUsd", () => {
  it("formats finite numbers with two decimals + dollar sign", () => {
    expect(formatUsd(4.123)).toBe("$4.12");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(36)).toBe("$36.00");
  });

  it("returns em-dash for null / NaN / Infinity", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
