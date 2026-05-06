// P3-T5 — pure helpers that turn the daemon's `schedules` cadence
// columns into human-readable text. Two shapes show up in the wild:
//
//   - cron mode: `cron_expr` populated, `interval_minutes` null.
//   - interval mode (legacy): `interval_minutes` populated, `cron_expr`
//     null. Daemon's `bridge_schedule_add` MCP tool currently only
//     accepts `interval_minutes`, so most production rows are this shape.
//
// `formatCadence` returns the human label rendered in the table's
// "Cadence" column (e.g. "Every day at 9:00 AM" or "Every 30 minutes").
// `formatNextRun` returns the next fire time — preferring the daemon-
// computed `nextRunAt`, falling back to a client-side `cron-parser`
// computation when the daemon hasn't populated the column yet.
//
// All helpers stay pure (no IO, no Date.now mutations) so the unit
// tests can drive them with fixed `now` values.

import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";

export interface CadenceInput {
  cronExpr: string | null;
  intervalMinutes: number | null;
}

export interface FormatNextRunInput extends CadenceInput {
  nextRunAt: string | null;
  // Pre-computed `now` for deterministic interval-mode fallback. Tests
  // always pass this; production code passes `new Date()`.
  now?: Date;
  // Optional last-run timestamp — used when interval-mode and the
  // daemon never filled `nextRunAt`. The daemon's scheduler is supposed
  // to set `nextRunAt = lastRunAt + intervalMinutes` so we mimic that
  // here. Falls back to `now` when both are missing (i.e. the schedule
  // has never fired).
  lastRunAt?: string | null;
}

const ONE_MINUTE_MS = 60_000;

// `cronstrue` throws on malformed expressions. We swallow and return
// the raw expression so the table at least surfaces *something*
// rather than a broken row. The schedule create dialog (P3-T6) is the
// place where bad input is rejected — the list view is read-only.
function formatCronExprHumanReadable(expr: string): string {
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: false });
  } catch {
    return expr;
  }
}

// Pretty-print a positive integer minute interval. Common buckets get
// a short label; everything else falls through to "Every N minutes".
function formatIntervalMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "—";
  }
  const m = Math.floor(minutes);
  if (m === 1) return "Every minute";
  if (m === 60) return "Every hour";
  if (m === 1440) return "Every day";
  if (m === 10_080) return "Every week";
  if (m % 1440 === 0) {
    const days = m / 1440;
    return `Every ${days} days`;
  }
  if (m % 60 === 0) {
    const hours = m / 60;
    return `Every ${hours} hours`;
  }
  return `Every ${m} minutes`;
}

export function formatCadence(input: CadenceInput): string {
  if (input.cronExpr !== null && input.cronExpr.trim().length > 0) {
    return formatCronExprHumanReadable(input.cronExpr.trim());
  }
  if (input.intervalMinutes !== null && input.intervalMinutes > 0) {
    return formatIntervalMinutes(input.intervalMinutes);
  }
  return "—";
}

// Best-effort next-run computation. Order:
//   1. Daemon-supplied `nextRunAt` (most authoritative).
//   2. Cron-parser `next()` from `now` when in cron mode.
//   3. `lastRunAt + intervalMinutes` (or `now + intervalMinutes` when
//      no last-run yet) for interval mode.
//   4. null — caller renders "—".
export function formatNextRun(input: FormatNextRunInput): string | null {
  if (input.nextRunAt !== null && input.nextRunAt.trim().length > 0) {
    return input.nextRunAt;
  }
  const now = input.now ?? new Date();
  if (input.cronExpr !== null && input.cronExpr.trim().length > 0) {
    try {
      const it = CronExpressionParser.parse(input.cronExpr.trim(), {
        currentDate: now,
      });
      const next = it.next();
      return next.toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (input.intervalMinutes !== null && input.intervalMinutes > 0) {
    let base: Date;
    if (input.lastRunAt !== null && input.lastRunAt !== undefined && input.lastRunAt.length > 0) {
      const parsed = new Date(input.lastRunAt);
      base = Number.isNaN(parsed.getTime()) ? now : parsed;
    } else {
      base = now;
    }
    return new Date(base.getTime() + input.intervalMinutes * ONE_MINUTE_MS).toISOString();
  }
  return null;
}
