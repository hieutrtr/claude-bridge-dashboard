# P3-T8 — Schedule run history drawer

> **Loop step 9/11.** Read-only feature: each `/schedules` row gets a
> "Runs" affordance that opens a side drawer with the last 30 dispatches
> originated by that schedule, each linking back to the task detail
> page (`/tasks/[id]`). No mutation in this task — closes the
> "managed without CLI" PRD goal by giving the user a forensic trail
> into what each schedule actually did.

## Goal

Surface, for any single schedule, the most recent N task rows that
*originated from that schedule's dispatch path* — so the user can
answer "what did my nightly-tests schedule actually run last week?"
without `sqlite3 bridge.db`.

The drawer reuses Phase 1 task-status badges + cost/duration
formatting; the only new wire surface is the `schedules.runs` query.
Per the v1 P3-T8 acceptance:

- Drawer opens within 200ms (`schedules.runs` is a single
  index-supported `SELECT … LIMIT 30`).
- Each row links to `/tasks/[id]` (existing route from Phase 1 T06).
- Status badge per run + cost + duration.

## Files touched

| Path | Status |
|---|---|
| `src/server/dto.ts` | +20 (`ScheduleRunRow`, `ScheduleRunsPage`) |
| `src/server/routers/schedules.ts` | +110 (`runs` query + helpers) |
| `src/lib/schedule-runs-client.ts` | new — pure browser fetch helper |
| `src/components/schedule-runs-drawer.tsx` | new — side drawer (View + wrapper) |
| `src/components/schedule-row-actions.tsx` | edit — add "Runs" trigger button |
| `app/schedules/page.tsx` | edit — mount `<ScheduleRunsDrawer>` once at page level |
| `tests/server/schedules-router.test.ts` | edit — extend with `runs` cases |
| `tests/lib/schedule-runs-client.test.ts` | new — request-builder coverage |
| `tests/app/schedule-runs-drawer.test.ts` | new — view-state matrix |
| `docs/tasks/phase-3/T08-schedule-runs.md` | new — this file |
| `docs/tasks/phase-3/T08-review.md` | new — code review |

## Wire shape — `schedules.runs`

```ts
// server input
{
  id: z.number().int().positive(),
  limit: z.number().int().min(1).max(100).default(30),
}

// server output
interface ScheduleRunRow {
  id: number;            // tasks.id
  status: string | null; // tasks.status
  costUsd: number | null;
  durationMs: number | null;
  channel: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

interface ScheduleRunsPage {
  scheduleId: number;
  scheduleName: string;
  agentName: string;
  items: ScheduleRunRow[];
  // True iff the schedule lookup itself succeeded; `null` when the
  // schedule id is unknown — the drawer renders an "unknown schedule"
  // notice instead of a 404 toast (clicking a stale row from a
  // background tab is the dominant case, not a security boundary).
}
```

## Heuristic — how we link a `tasks` row to its schedule

The daemon's vendored `tasks` schema has **no `schedule_id`** column
(see `src/db/schema.ts:27-66`). The scheduler dispatches via
`atomicCheckAndCreateTask(agent.session_id, schedule.prompt,
schedule.channel, schedule.channel_chat_id, undefined,
schedule.user_id)` (see
`claude-bridge/src/orchestration/scheduler.ts:80-88`) — so the only
columns we can use to identify a schedule-originated task are the
ones the daemon copies from the schedule row at dispatch time:

1. `tasks.session_id == agents.session_id` for the schedule's
   `agent_name` (resolved server-side via the `agents` table).
2. `tasks.prompt == schedule.prompt` (string equality — the daemon
   forwards verbatim).
3. `tasks.channel == schedule.channel`.

We filter on (1) + (2) + (3). `(channel, channel_chat_id, user_id)`
all also match exactly per the scheduler's call shape, but `prompt`
is the strongest discriminator — a manually dispatched task with
the *same exact prompt* to the *same agent* on the *same channel*
would still surface here, but that's rare enough we accept it as
a known limitation rather than introduce a Phase-4-blocker schema
change. The review file (`T08-review.md`) documents the limitation
so it's discoverable from the PR trail.

The query uses the existing `idx_tasks_session` index
(`src/db/schema.ts:60`) — `WHERE session_id = ? AND prompt = ? AND
channel = ?` ranges along that index then sorts by id DESC for the
`LIMIT 30` page. Predicted cost: well under the 50ms p95 budget at
typical schedule run-counts (≤ 10k rows for the most active
schedule).

## Daemon-side context

`bridge_schedule_*` MCP tools never expose schedule-run history; the
v1 ARCH §3 data model also has no `schedule_runs` table. All
forensic data lives implicitly in the daemon's `tasks` table — what
this task ships is the dashboard-side join that materialises the
forensic trail without a daemon-side schema change.

If the daemon ever grows a `tasks.schedule_id` column (filed against
`claude-bridge` as a Phase-4 entry note), this query collapses to
`WHERE schedule_id = ?` and the heuristic becomes a no-op.

## UX decisions

### Why a per-row "Runs" button (not whole-row click)

The schedule row already has clickable child elements: the agent
link (→ `/agents/[name]`) and the actions column buttons
(Pause/Resume/Delete). Wrapping the entire row in a click handler
would conflict with both — a click on the agent link would fire the
drawer trigger before navigating. We add a small "Runs" button to
the actions column instead. This matches the existing pause/resume/
delete pattern (single-click affordance, keyboard reachable via tab
order) and is more discoverable than a row-level click that the
user has to learn from a tooltip. The v1 P3-T8 acceptance ("click
row → side drawer") is satisfied in spirit by "click the Runs
button on the row" — the spec is about the *drawer surfacing*, not
the click target choice.

### Why a side drawer (not a modal dialog)

Two reasons. (1) The user's mental model is "show me more about
this schedule without losing my place in the list" — a side drawer
keeps the schedules table visible behind it, so the user can scan
runs across multiple schedules in sequence without losing scroll
position. (2) The runs table has a vertical-list shape (timestamps
+ rows of identical-shape data) that maps cleanly to the drawer's
narrow viewport. A centered modal would force the table either too
narrow (truncated columns) or too wide (overflows on tablet
viewports). The drawer is also the standard surface for "detail
attached to a list row" in shadcn — same pattern as the pending v1
ARCH §11 "agent runs" surface.

### Why we display run rows linking to /tasks/[id] (not a per-schedule detail page)

A `/schedules/[id]` route is filed against Phase 4 (see
`T07-schedule-actions.md` "Out of scope"). Phase 3 does not add it;
the drawer is the closest equivalent for now. Each run row links
out to `/tasks/[id]` — Phase 1 T06 already ships the task detail
page (status, cost, transcript via T07). Once Phase 4 lands a
schedule detail page, the drawer's "View detail →" footer link is
the obvious place to wire it up; Phase 3 leaves the footer absent
rather than fabricating a route.

### Why `prompt` participates in the join (privacy precedent)

Phase 2 / Phase 3 audit precedent forbids the *audit log* from
echoing prompt text. T08 is **not** an audit surface — it's a
read-only join across daemon-owned tables that already store the
prompt in cleartext (`schedules.prompt`, `tasks.prompt`). Filtering
on prompt equality is comparing two cleartext columns the daemon
already wrote; no new surface area for prompt leakage.

The drawer DOES NOT echo the schedule's `prompt` text in the wire
payload — it only echoes per-task columns (id, status, cost,
duration, channel, timestamps). The prompt is already visible on
the `/schedules` row and the `/tasks/[id]` detail page; no need to
re-echo it on the drawer.

### Why `limit` is on the query (not a constant 30)

v1 P3-T8 specs `last 30 runs` but the underlying query is a generic
"last N runs". Exposing `limit` keeps the procedure reusable for
future surfaces (a hypothetical CSV export, a weekly digest email).
The default is 30 (matches the AC); the cap is 100 (above the
no-virtualization threshold per v1 ARCH §11 — keeps a runaway
client from forcing a 100k-row scan).

## Acceptance criteria — pinned by tests

- [x] `schedules.runs({ id, limit? })` returns
      `{ scheduleId, scheduleName, agentName, items[] }`.
- [x] Unknown `id` → throws `NOT_FOUND` (mirrors `pause/resume/remove`).
- [x] Items ordered by `tasks.id DESC` (most-recent first).
- [x] `limit` defaults to 30; clamped to [1, 100].
- [x] Items filter by `session_id` (resolved from agents table) AND
      `prompt` AND `channel` so unrelated tasks on the same agent
      don't bleed in.
- [x] Items include `id, status, costUsd, durationMs, channel,
      createdAt, completedAt` — the columns the drawer renders.
- [x] No audit row (read-only query — Phase 2 audit-scope decision).
- [x] No CSRF / rate-limit (route is GET on tRPC, same as
      `tasks.list`).
- [x] Drawer mounts at the page level (single instance) and opens
      via a custom-event broadcast from each row's "Runs" button
      (mirrors the dispatch-dialog pattern from Phase 2 T02).
- [x] Drawer renders status badge + cost + duration per row.
- [x] Each drawer row links to `/tasks/[id]`.
- [x] Empty state copy: "No runs yet — this schedule hasn't fired."
- [x] Loading state ("Loading runs…") + error state surface
      cleanly.
- [x] `bun run test` (existing + new T8 cases) all pass.
- [x] `bun run build` produces a clean Next.js bundle.

## Out of scope / follow-ups

- **`tasks.schedule_id` column on the daemon side.** Filed against
  `claude-bridge` as a Phase-4 entry note. With it, the heuristic
  collapses to a single foreign-key lookup and the prompt-equality
  filter becomes redundant.
- **`/schedules/[id]` detail page.** Phase 4. The drawer is the
  Phase-3 stand-in.
- **Run-history pagination beyond the first 30/N.** A "Load more"
  button would be the obvious extension; deferred until a
  deployment surfaces the need.
- **Cost-per-run sparkline inside the drawer.** The drawer's wire
  payload already carries `costUsd` per run — adding a sparkline
  is a UI-only follow-up that doesn't need a new tRPC surface.
  Filed as a Phase-4 polish item.
- **SPA-click E2E for the drawer.** The Phase 3 INDEX test surface
  plan keeps the contract-level pattern (network assertions); a
  full SPA-click E2E is deferred per Phase 2 follow-up §5.
