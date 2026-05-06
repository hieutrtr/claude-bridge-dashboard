// P3-T5 — pure unit tests for `formatCadence` + `formatNextRun`.
// No IO, no DB; just exercises the cron-parser / cronstrue wrappers
// against the daemon's two schedule shapes (cron-mode + interval-mode)
// plus the malformed-input fallbacks.

import { describe, it, expect } from "bun:test";

import { formatCadence, formatNextRun } from "../../src/lib/cron-format";

describe("formatCadence — cron mode", () => {
  it("renders a daily-9am cron expression in plain English", () => {
    expect(formatCadence({ cronExpr: "0 9 * * *", intervalMinutes: null }))
      .toBe("At 09:00 AM");
  });

  it("renders an hourly cron expression in plain English", () => {
    // cronstrue 3.x normalises `0 * * * *` to "Every hour"; older
    // versions emit "At 0 minutes past the hour". The contract here
    // is "human-readable string from cronstrue", not a specific
    // string — we just assert the output isn't the raw expression.
    const out = formatCadence({ cronExpr: "0 * * * *", intervalMinutes: null });
    expect(out).not.toBe("0 * * * *");
    expect(out.toLowerCase()).toContain("hour");
  });

  it("renders a weekly Mon-9am cron expression in plain English", () => {
    expect(
      formatCadence({ cronExpr: "0 9 * * 1", intervalMinutes: null }),
    ).toBe("At 09:00 AM, only on Monday");
  });

  it("trims whitespace before parsing", () => {
    expect(
      formatCadence({ cronExpr: "  0 9 * * *  ", intervalMinutes: null }),
    ).toBe("At 09:00 AM");
  });

  it("falls back to the raw expression when cronstrue throws", () => {
    expect(
      formatCadence({ cronExpr: "not a cron expr", intervalMinutes: null }),
    ).toBe("not a cron expr");
  });

  it("prefers cron mode over interval mode when both are populated", () => {
    expect(
      formatCadence({ cronExpr: "0 9 * * *", intervalMinutes: 60 }),
    ).toBe("At 09:00 AM");
  });
});

describe("formatCadence — interval mode", () => {
  it("renders 1 → 'Every minute'", () => {
    expect(formatCadence({ cronExpr: null, intervalMinutes: 1 }))
      .toBe("Every minute");
  });

  it("renders 60 → 'Every hour'", () => {
    expect(formatCadence({ cronExpr: null, intervalMinutes: 60 }))
      .toBe("Every hour");
  });

  it("renders 1440 → 'Every day'", () => {
    expect(formatCadence({ cronExpr: null, intervalMinutes: 1440 }))
      .toBe("Every day");
  });

  it("renders 10080 → 'Every week'", () => {
    expect(formatCadence({ cronExpr: null, intervalMinutes: 10080 }))
      .toBe("Every week");
  });

  it("renders an hour-multiple → 'Every N hours'", () => {
    expect(formatCadence({ cronExpr: null, intervalMinutes: 180 }))
      .toBe("Every 3 hours");
  });

  it("renders a day-multiple → 'Every N days'", () => {
    expect(formatCadence({ cronExpr: null, intervalMinutes: 4320 }))
      .toBe("Every 3 days");
  });

  it("renders a non-bucket interval → 'Every N minutes'", () => {
    expect(formatCadence({ cronExpr: null, intervalMinutes: 30 }))
      .toBe("Every 30 minutes");
  });

  it("treats negative or zero intervals as '—'", () => {
    expect(formatCadence({ cronExpr: null, intervalMinutes: 0 })).toBe("—");
    expect(formatCadence({ cronExpr: null, intervalMinutes: -5 })).toBe("—");
  });
});

describe("formatCadence — neither column populated", () => {
  it("renders '—' when both columns are null", () => {
    expect(formatCadence({ cronExpr: null, intervalMinutes: null }))
      .toBe("—");
  });

  it("renders '—' when cron is whitespace-only and interval is null", () => {
    expect(formatCadence({ cronExpr: "   ", intervalMinutes: null }))
      .toBe("—");
  });
});

// ─────────────────────────────────────────────────────────────────────
// formatNextRun
// ─────────────────────────────────────────────────────────────────────

describe("formatNextRun — daemon-supplied nextRunAt wins", () => {
  it("returns nextRunAt verbatim when populated, regardless of cron/interval", () => {
    expect(
      formatNextRun({
        cronExpr: "0 9 * * *",
        intervalMinutes: 60,
        nextRunAt: "2026-05-07T09:00:00.000Z",
      }),
    ).toBe("2026-05-07T09:00:00.000Z");
  });
});

describe("formatNextRun — cron fallback when nextRunAt is missing", () => {
  it("computes the next fire time using cron-parser from `now`", () => {
    const now = new Date("2026-05-06T08:30:00.000Z");
    const out = formatNextRun({
      cronExpr: "0 9 * * *",
      intervalMinutes: null,
      nextRunAt: null,
      now,
    });
    expect(out).toBe("2026-05-06T09:00:00.000Z");
  });

  it("returns null when cronExpr is malformed", () => {
    const out = formatNextRun({
      cronExpr: "not a cron",
      intervalMinutes: null,
      nextRunAt: null,
      now: new Date("2026-05-06T08:30:00.000Z"),
    });
    expect(out).toBeNull();
  });
});

describe("formatNextRun — interval fallback when nextRunAt is missing", () => {
  it("computes lastRunAt + intervalMinutes when both are present", () => {
    const out = formatNextRun({
      cronExpr: null,
      intervalMinutes: 30,
      nextRunAt: null,
      lastRunAt: "2026-05-06T08:00:00.000Z",
      now: new Date("2026-05-06T08:30:00.000Z"),
    });
    expect(out).toBe("2026-05-06T08:30:00.000Z");
  });

  it("falls back to now + intervalMinutes when no lastRunAt", () => {
    const out = formatNextRun({
      cronExpr: null,
      intervalMinutes: 30,
      nextRunAt: null,
      lastRunAt: null,
      now: new Date("2026-05-06T08:00:00.000Z"),
    });
    expect(out).toBe("2026-05-06T08:30:00.000Z");
  });

  it("treats malformed lastRunAt as missing → uses now", () => {
    const out = formatNextRun({
      cronExpr: null,
      intervalMinutes: 30,
      nextRunAt: null,
      lastRunAt: "not a date",
      now: new Date("2026-05-06T08:00:00.000Z"),
    });
    expect(out).toBe("2026-05-06T08:30:00.000Z");
  });
});

describe("formatNextRun — unable to compute", () => {
  it("returns null when neither cron nor interval are usable", () => {
    const out = formatNextRun({
      cronExpr: null,
      intervalMinutes: null,
      nextRunAt: null,
      now: new Date("2026-05-06T08:00:00.000Z"),
    });
    expect(out).toBeNull();
  });

  it("returns null when intervalMinutes is non-positive and cron is missing", () => {
    const out = formatNextRun({
      cronExpr: null,
      intervalMinutes: 0,
      nextRunAt: null,
      now: new Date("2026-05-06T08:00:00.000Z"),
    });
    expect(out).toBeNull();
  });
});
