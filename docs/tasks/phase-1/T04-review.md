# P1-T04 review — `agents.get` + Agent detail page (Tasks tab only)

> Self-review checklist for Rule 3 of the loop process.

## Files added

- `src/server/routers/tasks.ts` — `tasks.listByAgent` query (cursor
  pagination, agent-name → session-id resolution, DTO projection,
  Zod input validation). Read-only — no mutation surface.
- `src/lib/task-status.ts` — pure `taskStatusBadge(status)` helper +
  `TaskStatusVariant` / `TaskStatusBadge` types. Mirrors the shape of
  `agentStatusBadge`.
- `src/components/task-table.tsx` — agent-detail Tasks tab table. Pure
  presentational; truncates prompts to 80ch with full text in `title`.
  Renders the "Next →" link only when `nextCursor !== null`. Empty
  state instructs the user to dispatch via CLI / MCP.
- `src/components/agent-tabs.tsx` — tab strip (Tasks / Memory / Cost)
  driven by `?tab=` URL search-param so the page can stay a server
  component. `isAgentTab` type guard exported for the page route.
- `app/agents/[name]/page.tsx` — Next.js dynamic-segment server
  component. Resolves the URL-decoded name, calls `agents.get`, 404s
  if missing, fetches `tasks.listByAgent` only when `tab === "tasks"`.
  Memory / Cost tabs render placeholder Cards pointing at T10 / T09.
- `tests/server/tasks-router.test.ts` — 10 tests, 26 expects. Covers
  unknown-agent empty page, ordering, default+max limits, Zod limit
  bounds, cursor filter, DTO projection, cross-agent isolation, and
  duplicate-name rescue across two project dirs.
- `tests/lib/task-status.test.ts` — 8 tests, 11 expects. Covers each
  documented status + null + unknown future-state.
- `docs/tasks/phase-1/T04-agent-detail-tasks-tab.md` — task spec
  (acceptance + TDD plan + open notes) — Rule 1.

## Files modified

- `src/server/dto.ts` — added `AgentTaskRow` and `AgentTaskPage`
  interfaces (8-field projection of the `tasks` row + cursor envelope).
  No change to `Agent`.
- `src/server/routers/agents.ts` — added `agents.get({ name })` query
  using a shared `AGENT_DTO_SELECTION` constant so `list` and `get`
  return identical shapes. Tie-break on `project_dir ASC` for the rare
  duplicate-name case; documented inline.
- `src/server/routers/_app.ts` — registered `tasks: tasksRouter`.
- `src/components/agents-grid.tsx` — wrapped each Card in `<Link>` to
  `/agents/[name]` (URL-encoded). Added focus-visible ring for keyboard
  accessibility + hover ring affordance.
- `tests/server/agents-router.test.ts` — extended with a new
  `describe("agents.get")` block: 5 tests, 13 expects (empty DB, no
  match, full DTO match, project_dir tie-break, empty-name rejection).

## Files deleted

- None.

## Test results

```
$ bun test
 84 pass
 0 fail
 235 expect() calls
Ran 84 tests across 10 files.

$ bun run typecheck
$ tsc --noEmit         # exit 0
```

61 prior tests (Phase 0 + T01 + T02 + T03) + 23 new T04 tests = 84
total / 235 expects.

## Self-review checklist

- [x] **Tests cover happy + edge case** —
  - `agents.get`: empty DB, no-match, full DTO, name collision tie-break,
    empty-name input rejection.
  - `tasks.listByAgent`: ghost agent, zero tasks, ordering DESC, default
    limit 50 + nextCursor surfacing, fewer-than-limit nextCursor null,
    cursor filter (id < cursor) + no overlap with previous page, Zod
    limit bounds (>100 + <1 both reject), cross-agent isolation,
    DTO projection (8 keys), and duplicate-name rescue across two
    project dirs.
  - `taskStatusBadge`: 6 documented statuses + null + unknown.
- [x] **Not over-engineered** — no shared `<Tabs>` primitive yet (URL-
      driven Link strip handles 3 tabs cleanly); no virtualization on
      the table (≤ 50 rows / page); no Prev link in pagination
      (forward-only is enough for "50 most recent"; flagged for T11).
      The `AGENT_DTO_SELECTION` const is reused so `list` and `get`
      cannot drift.
- [x] **ARCHITECTURE v2 picks honoured** — Next.js App Router server
      components only (`force-dynamic`, no client component added).
      tRPC v11 with `createCaller` (in-process — perf budget §11). Zod
      input validation with explicit min/max bounds. Drizzle `.select`
      projection (no `select *` payload bloat). bun:sqlite on the read
      path. Tailwind v4 tokens (`hsl(var(--*))`) + the existing
      shadcn primitives — no new dependency added. **No mutation
      procedure registered.**
- [x] **No secret leak** — payload contains zero session IDs (we
      resolve `sessionId` server-side and never echo it back).
      `result_file`, `pid`, `error_message`, and `parent_task_id` are
      deliberately dropped from the wire DTO. No env-var values
      surfaced; auth still enforced by `middleware.ts` (T02).
- [x] **Read-only invariant** — `tasks.listByAgent` and `agents.get`
      are both `query` (not `mutation`). Zero `bridge_dispatch`,
      `tasks.kill`, `loops.approve`, etc. The page is a server
      component with no `<form>` or `"use client"` directive. ✅
- [x] **Performance budget §11** — single SELECT per page (the
      session-id resolution is one extra small SELECT, both indexed
      via the `agents` PK and `idx_tasks_session`). Cursor (`id <
      cursor`) hits the `tasks` PK index; ordering by `id DESC` uses
      the same. Payload at limit 50 with average prompt < 200 chars
      ≈ 10–20 KB JSON — well inside §11 budget. Forward-only cursor
      avoids OFFSET scans on 10k-row tables.

## Issues found

- **None blocking.**
- **Minor / observational:**
  - **No "Prev" link.** The cursor encoding is inherently forward-only;
    users can only navigate page 1 → page 2 → page 3 by repeated Next
    clicks, and back-navigation relies on the browser back button. A
    full prev/next pair would need a back-stack (URL list of seen
    cursors) — out of scope for T04. Flagged for T11.
  - **`done` status reuses the `running` (green) variant.** Until T12
    polishes the badge palette with a dedicated "success" tone, this is
    the closest match. The label disambiguates so the test asserts
    label === "Done" but only loosely on variant.
  - **Prompt truncation is render-side.** Very long prompts still ship
    full text over the wire. T05 will introduce server-side truncation
    on the global Tasks list where 1k+ rows can really inflate payload.
  - **Dynamic route not in `route-stubs.test.ts`.** The static route
    list (5 routes) intentionally excludes parametric segments. The
    dynamic route is exercised at the data-layer (`agents.get` /
    `tasks.listByAgent` tests) and end-to-end in T13 Playwright spec.
  - **Memory / Cost tabs render placeholders.** Per scope ("Tasks tab
    only" in T04). The tab nav is fully wired so T09 / T10 only need
    to swap the placeholder for real content.
  - **Agent-name URL collisions.** Two agents with the same name in
    different `project_dir` paths cause the detail page to render only
    the lexicographically-first row. `tasks.listByAgent` *does*
    aggregate tasks across both sessions (test #10), so the user sees
    all tasks but only one project's metadata. Documented in T04 task
    spec as a Phase-2 polish item.

## Verification trail

- `bun test` → 84 pass / 0 fail / 235 expects.
- `bun run typecheck` → clean exit.
- `bun run build` deferred to phase-end step 15 (per loop plan).
- Browser/manual smoke deferred to loop step 16. Manual flow to verify:
  `/agents` → click any card → land on `/agents/<name>` → verify
  Tasks tab shows ≤ 50 most recent rows + Next link if > 50 → click
  Memory + Cost tabs → see placeholder cards.

## Sign-off

T04 complete. Ready for T05 (`tasks.list` global page with filters) on
next iter. INDEX checkbox updated.
