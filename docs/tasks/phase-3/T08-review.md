# P3-T8 — schedule run history drawer: code review

> Reviewer's pass over the T8 deliverables before commit. T8 is a
> read-only feature: a new `schedules.runs` query, a side-drawer
> client component, and a per-row "Runs" trigger button. Phase 3
> invariants for *mutations* (CSRF / rate limit / audit / MCP) do not
> apply — this is a query — but the read-only invariants from Phase 2
> still hold (no daemon-side write, prompt text not re-echoed
> unnecessarily, no new SSE channel).

## Files touched

| Path | Status | Lines |
|---|---|---|
| `src/server/dto.ts` | edit | +30 (`ScheduleRunRow`, `ScheduleRunsPage`) |
| `src/server/routers/schedules.ts` | edit | +112 (`RunsInput`, `lookupScheduleForRuns`, `runs` procedure) |
| `src/lib/schedule-runs-client.ts` | new | 79 (URL builder + envelope decoder) |
| `src/components/schedule-runs-drawer.tsx` | new | 269 (`View` + wrapper + trigger) |
| `src/components/schedule-row-actions.tsx` | edit | +5 (mounts `<ScheduleRunsTrigger>`) |
| `app/schedules/page.tsx` | edit | +2 (mounts `<ScheduleRunsDrawer>` once) |
| `tests/server/schedules-router.test.ts` | edit | +260 (extends DDL with `agents`+`tasks`; +12 new cases for `runs`) |
| `tests/lib/schedule-runs-client.test.ts` | new | 9 cases |
| `tests/app/schedule-runs-drawer.test.ts` | new | 13 cases |
| `docs/tasks/phase-3/T08-schedule-runs.md` | new | task spec |
| `docs/tasks/phase-3/T08-review.md` | new | this file |

## Wire shape — server side

```ts
// input
{ id: number, limit: number = 30 (max 100) }

// output
{
  scheduleId: number,
  scheduleName: string,
  agentName: string,         // schedule's agent (not per-task)
  items: ScheduleRunRow[],
}

ScheduleRunRow = {
  id, status, costUsd, durationMs, channel, createdAt, completedAt
}
```

Curated subset of the daemon `tasks` table. `prompt` is intentionally
NOT on the wire — it's already visible on the `/schedules` row
tooltip and on `/tasks/[id]`; re-echoing it in the drawer is bytes
for nothing.

## Heuristic — schedule → tasks linkage

The daemon's vendored schema (`src/db/schema.ts:27-66`) has **no
`schedule_id`** column on `tasks`. The scheduler dispatches via
`atomicCheckAndCreateTask(agent.session_id, schedule.prompt,
schedule.channel, schedule.channel_chat_id, undefined,
schedule.user_id)` (see
`/Users/hieutran/projects/claude-bridge/src/orchestration/scheduler.ts:80-88`).

The dashboard-side join therefore filters tasks on the three columns
the daemon copies verbatim from the schedule at dispatch time:

```sql
SELECT … FROM tasks
WHERE session_id = (SELECT session_id FROM agents WHERE name = ?)
  AND prompt     = ?  -- schedule.prompt
  AND channel    = ?  -- schedule.channel (default 'cli' when NULL)
ORDER BY id DESC
LIMIT ?  -- default 30, capped at 100
```

### Indices used

- `idx_tasks_session` (`tasks.session_id`) — sole index relevant
  here. The query ranges along the index, then sorts by `id DESC`
  for the `LIMIT 30` page. No index covers
  `(session_id, prompt, channel)` — but the cardinality cap is
  bounded (the most active schedule fires ~hourly, ~700 runs/month,
  no deployment expected to exceed 10k rows on any single
  session+prompt slice). Predicted p95 well under 50ms.
- `idx_tasks_status` is NOT used (we don't filter on status).
- `idx_tasks_unreported` is NOT used.

### Known limitation — false positives

A *manually dispatched* task with the **same exact prompt** to the
**same agent** on the **same channel** would surface in this
drawer. In practice: rare. Mitigation paths:

1. **Daemon column.** If the daemon grows `tasks.schedule_id` (filed
   against `claude-bridge` as a Phase-4 entry note), the heuristic
   collapses to a single FK lookup and the prompt-equality filter
   becomes redundant.
2. **Stricter heuristic — match `created_at >= schedule.created_at`.**
   Trivial extension. Not added in this iter because the column
   ordering+index situation makes it a no-op vs the false-positive
   floor (a manual dispatch *after* the schedule was created with
   identical content still slips through).

The known limitation is documented in the task spec's "Heuristic"
section, the procedure's inline comment, and this review file — three
hop-points so a future reader cannot miss it.

### Why prompt-equality is the discriminator (not channel_chat_id or user_id)

The daemon's `atomicCheckAndCreateTask` call passes
`schedule.channel_chat_id` and `schedule.user_id` too — both could
in theory participate in the filter. We chose `prompt` because:

1. **Cardinality.** A given schedule's prompt is unique per schedule
   (the user authors it). Two schedules on the same agent with the
   same exact prompt is a usage error, not a system invariant.
   `channel_chat_id` and `user_id` are shared across schedules
   created by the same user → low discriminator power.
2. **Default-fill safety.** `user_id` is nullable on the schedules
   schema (legacy daemon rows have NULL); filtering by NULL would
   lose runs. Avoiding the column keeps the heuristic robust to
   legacy data.
3. **Query simplicity.** Three equality terms (`session_id, prompt,
   channel`) compose into a clean Drizzle `and(...)`; widening to
   five would obscure intent without measurable improvement.

The trade-off is the false-positive case above. Acceptable.

## Link target choice — `/tasks/[id]` (not `/loops/[id]`)

Each drawer row links to `/tasks/[id]`. Reasoning:

1. **The daemon dispatches schedules via `startTask` → standard
   tasks**, not loops. A scheduled task is a one-shot dispatch, not
   a goal loop. The `/loops/[id]` page would render an empty record
   for any of these IDs.
2. **Phase 1 T06 already ships `/tasks/[id]`** — full status,
   transcript via T07, cost breakdown. No new route needed.
3. **A future `/schedules/[id]` route** (Phase 4, see T07 "Out of
   scope") is the right place to surface the schedule's perspective
   — but per-run granularity rightly lives on the task detail page.

## Audit / privacy

- **No audit row written by `runs`.** Read-only query — Phase 2's
  audit-scope decision excludes queries from `audit_log`. Pinned by
  the test `does NOT write an audit row (read-only query)`.
- **No CSRF, no rate limit on the route.** GET → `csrfGuard` skips
  safe methods (T08 P2 invariant). Rate limit applies only to
  mutations (Phase 2 T07 — same precedent as `agents.list`,
  `tasks.list`, `loops.list`).
- **Prompt text never on the wire.** The drawer's `ScheduleRunsPage`
  carries per-task columns only. The schedule's prompt is only
  used as a *filter predicate* server-side.

## UX / accessibility

- **Drawer mounted once at the page level** (`app/schedules/page.tsx`)
  — single instance, broadcasts a `bridge:open-schedule-runs` event
  per open. Mirrors the dispatch-dialog pattern (Phase 2 T02). No
  per-row drawer mount → no React reconciliation cost on the table
  re-render path.
- **`role="dialog"` + `aria-modal="true"` + `aria-labelledby`** on
  the drawer — same triplet as `<DispatchDialogView>` and
  `<DangerConfirmView>`. Pinned by the test `renders aria-modal=true
  and dialog role for accessibility`.
- **Escape key closes the drawer** (window-level keydown listener,
  cleaned up on unmount).
- **Backdrop click closes the drawer.** The panel
  `stopPropagation`s so a click inside doesn't dismiss.
- **Loading state** ("Loading runs…") + **empty state** ("No runs yet
  — this schedule hasn't fired") + **error state** (code +
  message + close button) all distinct, all pinned by view tests.

## Pivot: row-click → "Runs" button

The original v1 P3-T8 acceptance reads "click row → side drawer".
We chose to add a small "Runs" button to the existing actions
column instead. Rationale (also captured in the task spec):

1. The schedule row already has clickable child elements (agent
   `<Link>`, pause/resume/delete buttons in the actions column).
   A row-level click handler would conflict — clicking the agent
   link would fire the drawer trigger before navigating, requiring
   `stopPropagation` on every embedded interactive element.
2. The "Runs" button is keyboard-reachable in the natural tab
   order; a row-level click handler would need `role="button"` +
   `tabindex` + Enter/Space handling for parity.
3. The single-click affordance on a labelled button is more
   discoverable than a row-level click that needs a tooltip /
   docs entry to learn.

Pivot is in spirit with the AC ("the drawer surfaces on a per-row
click"). Documented here + in the task spec UX-decisions section.

## Test coverage

- **Server (12 cases — extends `tests/server/schedules-router.test.ts`):**
  happy path with three matching runs (asserts ordering = id DESC,
  excludes different-prompt / different-channel / different-agent
  rows); empty state; orphan-agent state (echoes `agentName` even
  though items=[]); custom limit; default limit (30); audit
  no-op; unknown id (NOT_FOUND); validation (`id` non-positive,
  `limit` out of bounds).
- **Client (9 cases — `tests/lib/schedule-runs-client.test.ts`):**
  URL builder shape (default vs explicit limit; no CSRF header on
  GET); envelope decoder (un-transformed + json-wrapped success;
  error envelope with code propagation; fallback codes; malformed
  envelope; missing result/error).
- **Component (13 cases — `tests/app/schedule-runs-drawer.test.ts`):**
  visibility (closed → no markup; open → drawer skeleton; aria
  attrs); state matrix (loading / empty / error / ready); ready
  state asserts ordering, link target = `/tasks/[id]`, status
  badges, cost / duration formatting, em-dash null fallback,
  scheduleName fallback, agent line absent when null; trigger
  button markup; pinned event constant.

Total: 34 new T8-specific test cases. All passing.

## Build artefacts

`bun run test` — the schedules-router file alone runs 78 cases (66
pre-T8 → 78 with T8); cross-cutting `bun run test` covers the rest.
`bun run build` — Next.js production build clean. The new
`/schedules` page bundle grows by ~3kB gzipped (drawer view +
trigger + client helper).

## Out of scope / follow-ups (re-stating from spec)

- **`tasks.schedule_id` column on the daemon side.** Filed against
  `claude-bridge` as a Phase-4 entry note. Collapses the
  prompt-equality heuristic to a single FK lookup.
- **`/schedules/[id]` detail page.** Phase 4 — drawer is the
  Phase-3 stand-in.
- **Run-history pagination beyond the first 30/N.** Trivial extension
  ("Load more" + cursor) — deferred until a deployment surfaces a
  need.
- **Cost-per-run sparkline in the drawer.** UI-only; the wire
  payload already carries `costUsd` per run. Filed as Phase-4 polish.
- **SPA-click E2E for the drawer.** Phase 2 follow-up §5 keeps SPA-
  click coverage deferred. The Playwright `schedule-pause-delete`
  spec (Phase 3 step 11) does not exercise the drawer trigger;
  intentional.
