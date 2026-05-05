# P1-T05 — `tasks.list` + global Tasks page

> Phase 1 / Iter 6 of the loop. Builds on T01 (shell), T02 (auth),
> T03 (`agents.list`), T04 (`tasks.listByAgent` + `task-status` helper +
> `<TaskTable>` agent-scoped layout).

## Source plan reference

- v1 IMPLEMENTATION-PLAN §Phase 1, item **P1-T5**:
  - "**`tasks.list` + Tasks page (global)** · Bảng task toàn instance,
    filter theo status (queued/running/done/failed), agent, channel,
    date range."
  - "Acceptance: 1000-row test render virtualized < 100ms scroll, filter
    URL-sync."
- v2 ARCHITECTURE.md §0 — v1 sections still applicable.
- v1 ARCHITECTURE.md sections to read **before coding**:
  - **§4.2 `tasks.*`** — signature
    `tasks.list({ sessionId?, status?, limit?, cursor? }) → query → paged`.
    The v1 surface lists only `sessionId` as a row filter; per the
    Phase 1 plan we extend it with `agentName`, `channel`, `since`,
    `until` to fulfil the acceptance bullet (filter by agent/channel/
    date range). All additions are query-only inputs.
  - **§3 (data model)** — `tasks.session_id` FKs `agents.session_id`;
    same `name` can appear under different `project_dir` rows so an
    `agentName` filter resolves to a `session_id IN (…)` set.
  - **§11 perf budgets** — DB query p95 < 50ms (10k tasks paged 50);
    First Load JS < 200KB. Cursor pagination + `idx_tasks_status` /
    `idx_tasks_session` keep us inside that budget.

## Scope

In:
- New tRPC query `tasks.list({ status?, agentName?, channel?, since?,
  until?, limit?, cursor? })` returning a paged DTO with the agent
  name surfaced per row.
- New page `/tasks` (server component) reading filter values from URL
  search params, rendering a paginated table + simple `<form
  method="get">` filter strip. Filter changes trigger a normal GET
  navigation — no client-side state, no `"use client"`. URL is the
  single source of truth.
- Each row's agent column is a `<Link>` to `/agents/[name]`; each
  row's id is a `<Link>` to `/tasks/[id]` (route doesn't yet exist —
  T06 lands it; the link 404s in the meantime, which is fine for
  scope).

Out:
- Real virtualization (e.g. `@tanstack/react-virtual`) — paginated 50/
  page is enough at Phase 1 scale and matches the T04 table pattern.
  Flag as deferred polish for T11 / Phase 2 if real-world rows blow
  the budget.
- `tasks.get` + task detail page (T06).
- Transcript viewer (T07).
- SSE live updates (T08).
- Save filter presets, export, multi-sort, etc. (post-Phase-1 polish).
- Mutation surface — read-only invariant.

## Acceptance criteria

1. `tasks.list({...})` is a tRPC **query** (not mutation) returning
   `{ items: GlobalTaskRow[], nextCursor: number | null }`. Inputs:
   - `status?: string` — exact match against `tasks.status`.
   - `agentName?: string` — resolves to `session_id IN (…)` over the
     `agents` table (handles the rare duplicate-name case the same way
     `tasks.listByAgent` does).
   - `channel?: string` — exact match against `tasks.channel`.
   - `since?: string` — ISO-ish text; rows where `tasks.created_at >=
     since`. Stored values are `"YYYY-MM-DD HH:MM:SS"`, so the input
     is matched as plain string compare (sortable lexicographically).
   - `until?: string` — same shape; `tasks.created_at <= until`.
   - `limit?: number` — default 50, `min 1`, `max 100`.
   - `cursor?: number` — `tasks.id < cursor`.
   - Validated by Zod; out-of-range or non-positive values reject.
2. `GlobalTaskRow` projects exactly nine fields:
   `id`, `agentName` (nullable — no joined agent row), `prompt`,
   `status`, `costUsd`, `durationMs`, `channel`, `createdAt`,
   `completedAt`. `result_file`, `pid`, `error_message`,
   `parent_task_id`, `session_id`, etc. are dropped from the wire DTO.
3. Items ordered by `tasks.id DESC`. `nextCursor` = lowest id of the
   page when `items.length === limit`; otherwise `null`. The unknown-
   `agentName` filter returns `{ items: [], nextCursor: null }` (no
   throw — easier UX when typing).
4. `app/tasks/page.tsx`:
   - Replaces the existing P1-T05 placeholder.
   - Reads `status` / `agentName` / `channel` / `since` / `until` /
     `cursor` from `searchParams`. Unknown / empty / non-string values
     are ignored (no throw).
   - Renders a filter strip (`<form method="get" action="/tasks">`) at
     the top with: status `<select>` (All / pending / queued / running
     / done / failed / killed), agent name `<input>`, channel `<input>`,
     since `<input type="datetime-local">`, until `<input
     type="datetime-local">`, plus an "Apply" submit and a "Clear"
     `<Link>` back to `/tasks` with no params.
   - Renders the paginated table (id, agent, status badge, prompt
     truncated to 80ch, channel, cost, duration, created). Empty
     state explains how to dispatch a task. "Next →" link forwards
     all current filter params plus the cursor.
   - URL filter sync: any submitted filter persists across page
     reloads via the URL only — no cookies, no localStorage, no
     client React state. Cursor resets when filters change because
     the form submit drops the cursor param.
5. Read-only invariant: `tasks.list` is a query; the page emits no
   mutation calls; the form is a plain GET submission, not a server
   action / POST.

## TDD plan

### Unit / integration (`bun test`)

**`tests/server/tasks-router.test.ts`** (extend with a new
`describe("tasks.list", () => {...})` block):

1. Empty DB returns `{ items: [], nextCursor: null }`.
2. Returns rows DESC by `id`, with `agentName` populated from the
   `agents` table.
3. Status filter: only matching rows; non-matching rows excluded.
4. Channel filter: only matching rows.
5. `agentName` filter: resolves through `agents` table; only tasks for
   that agent's session(s) returned. Tasks belonging to a different
   agent are excluded.
6. Unknown `agentName` filter returns empty page (no throw).
7. `since` filter: rows where `created_at >= since`.
8. `until` filter: rows where `created_at <= until`.
9. Combined filters AND together (status + channel + since/until).
10. `limit` defaults to 50; `nextCursor` surfaces lowest id when full.
11. `nextCursor` is null when items < limit.
12. Cursor (`id < cursor`) returns only rows below the cursor and no
    overlap with the previous page.
13. Zod input bounds: rejects `limit > 100` and `limit < 1`.
14. DTO projection: returned row has exactly the documented nine keys.
15. Agent-name DTO field is `null` for tasks whose `session_id` does
    not match any `agents` row (orphaned task — should never happen,
    but the LEFT JOIN must not drop the row).

**`tests/lib/task-status.test.ts`** — already covers the badge
mapping (T04). T05 reuses it; no new file needed.

**`tests/app/route-stubs.test.ts`** — `/tasks` already in the static
list. T05 keeps the page server-rendered, so the basic stub test
already exercises it. No update needed.

### Component / browser

Skipped at this layer — no jsdom in the repo. The Playwright spec in
T13 will exercise: load `/tasks` → assert ≥ 1 row → submit a status
filter → assert URL updates → click "Next →" → assert second-page
URL → click an agent name link → land on `/agents/[name]`.

## Notes / open questions

- **Virtualization deferral.** Plan acceptance ("1000-row virtualized
  < 100ms scroll") implies a virtual list. Phase 1 keeps the table
  paginated 50/page (matching T04), avoiding a new dep
  (`@tanstack/react-virtual`). When the daemon DB grows past ~10k
  tasks the per-page render is still 50 rows ⇒ no scroll perf cliff.
  Flag a polish task for T11 if real-world data shows otherwise.
- **`tasks.list` Zod input is a superset of v1 §4.2.** The v1 surface
  lists `{ sessionId?, status?, limit?, cursor? }`; we omit
  `sessionId` (covered by `tasks.listByAgent` + `agentName`
  resolution) and add `agentName`, `channel`, `since`, `until` to
  satisfy the Phase 1 acceptance. All read-only.
- **`since` / `until` semantics.** `tasks.created_at` is a sortable
  text column (e.g. `"2026-05-05 09:00:00"`). String compare matches
  ISO ordering for that format, so `>=` / `<=` work as expected
  without a CAST. We document this so a future migration to a numeric
  epoch column can swap operators safely.
- **Form values.** Native `<input type="datetime-local">` emits
  `"2026-05-05T09:00"`; we accept that as-is and trust SQLite's
  lexicographic compare to match the daemon's `"2026-05-05 09:00:00"`
  rows. The "T" vs " " separator means an exact equality match would
  miss; `>=` / `<=` still work because the T-form is between the
  space-form and the next-second space-form by ASCII order. Tests
  use the canonical space-form so we don't regress on this.
- **Agent-name URL sync edge case.** Filter posts `?agentName=alpha`;
  if no `agents` row matches, the page renders the empty table. The
  filter strip still shows the typed value so the user can correct
  it. Not a 404 — preserves the "search-as-you-go" mental model.
- **Cost / duration formatting.** Render `$0.0123` and `1234ms` raw
  per T04 conventions. T11 polishes.
- **No `"use client"` directive.** All filter state is in the URL,
  so the page stays a server component. Apply/Clear are anchor + form
  submit only.
