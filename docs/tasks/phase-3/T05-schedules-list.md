# P3-T5 — `schedules.list` router + `/schedules` page

> **Loop step 6/11.** Schedules-vertical entry point. Same shape as
> P3-T1 (loops vertical entry): a read-only query plus a server-rendered
> table page. No mutations this iter — the create/pause/resume/delete
> surface lands in T6 + T7. Inherits the Phase 3 invariants from
> `INDEX.md` but only the *read-side* ones apply (no MCP, no audit, no
> CSRF — queries don't mutate state).

## Goal

Replace the `/schedules` placeholder (Phase 1 stub) with a populated
table reading the daemon's vendored `schedules` table. The user opens
this page to answer one question: **"what's about to fire next, and is
anything stuck?"** Ordering and badge choices encode that intent.

Per v1 P3-T5 acceptance:

1. Cron expressions render in plain English (`cronstrue.toString`).
2. Bare `interval_minutes`-only schedules (legacy daemon shape) display
   "Every N minutes" — bucketed where useful (Every minute / hour / day
   / week / N hours / N days).
3. Row click opens history drawer — **stub for T5**, fully wired in T8.
4. Filter strip narrows by agent (URL-as-truth, same pattern as
   `/loops`).
5. `next_run` falls back to a `cron-parser`-computed next fire time
   when the daemon hasn't populated `nextRunAt`.

## Files touched

| Path | Status |
|---|---|
| `src/lib/cron-format.ts` | new — 100 (formatCadence + formatNextRun) |
| `src/server/dto.ts` | +37 (`ScheduleListRow`, `ScheduleListPage`) |
| `src/server/routers/schedules.ts` | new — 130 (`schedules.list`) |
| `src/server/routers/_app.ts` | +2 (mount `schedulesRouter`) |
| `src/components/schedule-filters.tsx` | new — 51 (`<form method="get">`) |
| `src/components/schedule-table.tsx` | new — 165 (presentational) |
| `app/schedules/page.tsx` | replace stub — 53 (server component) |
| `tests/lib/cron-format.test.ts` | new — 24 cases |
| `tests/server/schedules-router.test.ts` | new — 9 cases |
| `tests/app/schedules-page.test.ts` | new — 14 cases |

## Wire shape — `schedules.list`

```ts
// server input
agent: z.string().min(1).optional()

// server output
interface ScheduleListPage {
  items: ScheduleListRow[]
}

interface ScheduleListRow {
  id: number
  name: string
  agentName: string
  prompt: string                  // user-navigated-here rule applies
  cronExpr: string | null         // either / or
  intervalMinutes: number | null  // either / or
  enabled: boolean
  runOnce: boolean
  runCount: number
  consecutiveErrors: number
  lastRunAt: string | null
  nextRunAt: string | null
  lastError: string | null
  channel: string | null
  createdAt: string | null
}
```

### Why no `cursor` pagination?

Schedules are finite — the median deployment will have far fewer than
50. The page renders the entire table without virtualization (well below
the v1 ARCH §11 threshold). When deployments cross that line we'll add
keyset pagination on `id`-DESC; for now the simpler shape keeps the
filter-default-Unknown-agent lookup a single trip.

### Why `prompt` IS on the wire (vs `goal` privacy precedent)

The audit-log privacy precedent (`hasGoal:true` instead of echoing the
text) only applies to *audit*, not to UI rendering. The user navigated
to `/schedules` and is the schedule's owner — same "user navigated
here" rule that justifies showing `goal` on `/loops/[id]`. The list
truncates to a 80-char preview with the full text in the row tooltip
(`title=` attr).

## Ordering decision — soonest fire first, paused at the bottom

The page sorts client-side after pulling the daemon's `id`-DESC
default:

1. **Bucket A** (`nextRunAt` populated) — sorted ASC. Soonest fire-time
   first. Answers "what runs next?" at a glance.
2. **Bucket B** (`nextRunAt` null) — paused or never-fired schedules.
   Drops to the bottom; preserves the daemon's `id`-DESC default
   (most-recently-created first).

We can't express NULLS-LAST in Drizzle's typed `orderBy` without a raw
expression, and a custom client-side partition is clearer to reason
about than `CASE WHEN ... IS NULL THEN ...` SQL. Schedule volume is
low enough that the JS sort is a non-issue.

## Cadence formatting — cron mode vs interval mode

The daemon writes cadence as one of two shapes:

| Shape | `cron_expr` | `interval_minutes` | Display |
|---|---|---|---|
| cron | `"0 9 * * *"` | NULL | `cronstrue.toString` → "At 09:00 AM" |
| interval (legacy) | NULL | `30` | "Every 30 minutes" |

`bridge_schedule_add` (per `CLAUDE.md`) currently only accepts
`interval_minutes`. Cron-mode rows arrive only via the daemon's CLI
or a future MCP-tool extension. The dashboard renders both today; T6
will wire the create dialog (interval-only initially, with cron→interval
conversion if the daemon never grows native cron support).

`cronstrue` throws on malformed expressions; we swallow the throw and
return the raw expression so the row stays renderable. The schedule-
create dialog (T6) is the right place to *reject* bad input — the list
view is read-only and tolerant.

## `formatNextRun` fallback chain

Best-effort next-run computation, in priority order:

1. **Daemon-supplied `nextRunAt`** — most authoritative; the daemon's
   scheduler maintains this column.
2. **Cron-parser `next()` from `now`** — when in cron mode and the
   daemon hasn't populated `nextRunAt` yet.
3. **`lastRunAt + intervalMinutes`** — interval mode fallback,
   mimicking the daemon's scheduler arithmetic.
4. **`now + intervalMinutes`** — interval mode with no last-run.
5. **null** — caller renders "—".

Tests inject `now` deterministically; production code passes
`new Date()` per render. `now` is captured **once per render** in
`<ScheduleTable>` so all rows resolve their fallback against the same
instant — avoids the visual jitter of per-row `Date.now()` drift.

## Status badge mapping

| Condition | Label | Badge variant |
|---|---|---|
| `enabled === false` | "Paused" | idle |
| `consecutiveErrors > 0 && lastError !== null` | "Failing" | error |
| otherwise (enabled, healthy) | "Active" | running |

The "Failing" condition mirrors the daemon's notion of "this schedule
has an error trail attached" — a single failed run with
`consecutiveErrors=0` (recovered next iter) doesn't trip the badge.

## Test coverage

- **`cron-format.test.ts`** (24 cases) — every cadence/next-run branch:
  cron-mode happy path (daily/weekly/hourly/whitespace), cron-mode
  malformed fallback, interval-mode buckets (1, 60, 1440, 10080,
  hour-multiple, day-multiple, non-bucket), neither-column-populated,
  nextRunAt-wins, cron `next()` from now, interval lastRunAt+interval,
  interval malformed-lastRunAt, neither-mode-usable.

- **`schedules-router.test.ts`** (9 cases) — ordering (nextRunAt ASC,
  nulls last); wire shape (cron mode, interval mode, disabled,
  nullable columns); agent filter; input validation (empty string).

- **`schedules-page.test.ts`** (14 cases) — module surface (read-only
  invariant: no POST/PUT/PATCH/DELETE export); empty state (no rows /
  filtered no rows); populated table (cronstrue rendering, interval
  buckets, paused/failing/active status, run count, prompt truncation
  with full text in tooltip); URL → query mapping (agent filter,
  filter-strip default reflection); ordering (soonest first / nulls
  last).

## Acceptance checklist

- [x] Cron expressions render in plain English on the populated page.
- [x] Bare interval-mode rows display "Every N minutes" (or bucketed
      labels: hour / day / week / N hours / N days).
- [x] `nextRunAt` falls back to a `cron-parser`-computed time when the
      daemon hasn't filled the column.
- [x] Agent filter URL-round-trips via `<form method="get">`.
- [x] Empty / filtered-empty / populated states all render via the
      Phase 1 T11 primitives reused (Card, Badge).
- [x] Read-only invariant: no `"use client"` at the page level; no
      POST/PUT/PATCH/DELETE exports.
- [x] Tests pass: `bun test tests/lib tests/app tests/server` clean.
- [x] Build passes: `bun run build` clean. `/schedules` route weight =
      171 B (server-rendered, no client JS).

## Open follow-ups (carry into next iters)

- **T6** (next iter) wires `schedules.add` mutation + new-schedule
  dialog with cron picker. Will introduce the cron picker component
  (`src/components/cron-picker.tsx`) and reuse `formatCadence` for the
  preset preview.
- **T7** wires inline pause/resume/delete buttons; will mount a client
  island per row but the page itself stays server-rendered.
- **T8** wires the "row click → run history drawer" — currently rows
  are non-clickable; the drawer trigger lands in T8.
- **T9** wires the cost forecast helper inside the T6 dialog. Reuses
  `formatCadence` and the cron-parser iteration counting logic.
