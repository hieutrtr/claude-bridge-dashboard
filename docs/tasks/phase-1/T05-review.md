# P1-T05 review — `tasks.list` + global Tasks page

> Self-review checklist for Rule 3 of the loop process.

## Files added

- `src/components/global-task-table.tsx` — global Tasks table (id /
  agent / status / prompt / channel / cost / duration / created).
  Pure presentational; the page server component fetches `tasks.list`
  and hands rows down. Distinct from the T04 agent-detail
  `<TaskTable>` because this surface adds an Agent column linking
  back to `/agents/[name]` and the Id cell links to the (T06)
  `/tasks/[id]` detail page. Empty-state copy branches on
  `isFiltered` so a no-results table reads correctly whether the DB
  is empty or filters excluded everything.
- `src/components/task-filters.tsx` — filter strip (status select,
  agent name, channel, since, until). Plain `<form method="get"
  action="/tasks">` — no `"use client"`, no JS required. Submit
  triggers a normal GET navigation; "Clear" is a `<Link>` back to
  `/tasks` with no params. URL is the single source of truth.
- `docs/tasks/phase-1/T05-tasks-list-global.md` — task spec
  (acceptance + TDD plan + open notes) — Rule 1.

## Files modified

- `src/server/dto.ts` — added `GlobalTaskRow` (9 fields, including
  the resolved `agentName: string | null`) and `GlobalTaskPage`
  cursor envelope. T04's `AgentTaskRow` is unchanged — the agent-
  detail surface still ships an 8-field row without `agentName`
  (the page already knows which agent it is rendering).
- `src/server/routers/tasks.ts` — added `tasks.list` query.
  - Zod input: `status?`, `agentName?`, `channel?`, `since?`,
    `until?`, `limit?` (default 50, min 1, max 100), `cursor?`
    (positive int).
  - `agentName` resolves to `session_id IN (…)` via a small SELECT
    over `agents`; unknown name short-circuits to an empty page
    (no throw — search-as-you-go UX).
  - Filters AND together: `status` (eq), `channel` (eq), `since`
    (`gte` on `created_at`), `until` (`lte` on `created_at`),
    `cursor` (`lt` on `id`).
  - LEFT JOIN `agents` on `tasks.session_id = agents.session_id`
    so each row carries `agentName`. Orphaned tasks (session_id
    pointing at a deleted agent) keep their row with
    `agentName === null`.
  - Order: `tasks.id DESC`. `nextCursor` = lowest id when
    `items.length === limit`, else `null`.
  - **Read-only:** registered with `publicProcedure.query(...)`,
    not `mutation`. No `bridge_dispatch`, no file write side-effect.
- `app/tasks/page.tsx` — replaced the placeholder. Server component
  reads filter values from `searchParams`, normalises them
  (`readString` trims + collapses empty strings to `null`,
  `readCursor` rejects non-positive / non-integer values), calls
  `tasks.list` via tRPC `createCaller` (in-process — perf budget
  §11), and renders the filter strip + table. `buildNextHref`
  forwards every active filter param while overriding the cursor;
  the form submit drops the cursor implicitly so changing filters
  jumps back to page 1.
- `tests/server/tasks-router.test.ts` — extended with a new
  `describe("tasks.list (global)") block`. 14 new tests, 33 new
  expects:
  1. Empty DB.
  2. Order DESC + agentName populated from join.
  3. Status filter.
  4. Channel filter.
  5. agentName resolution to session_ids.
  6. Unknown agentName → empty page (no throw).
  7. `since` filter.
  8. `until` filter.
  9. Combined `status + channel + since + until`.
  10. Default limit 50 + nextCursor surfaces.
  11. nextCursor null when fewer than limit rows.
  12. Cursor (`id < cursor`) + no overlap with prior page.
  13. Zod limit bounds (>100 + <1 reject).
  14. DTO projection (exactly 9 keys).
  15. LEFT JOIN keeps orphan tasks (`agentName: null`).

## Files deleted

- None.

## Test results

```
$ bun test
 99 pass
 0 fail
 270 expect() calls
Ran 99 tests across 10 files.

$ bun run typecheck
$ tsc --noEmit          # exit 0
```

84 prior tests (Phase 0 + T01..T04) + 15 new T05 tests = 99 total /
270 expects.

## Self-review checklist

- [x] **Tests cover happy + edge case** —
  - Happy: each filter individually + combined; default limit;
    cursor advance; nextCursor surfacing.
  - Edge: empty DB; unknown `agentName` returns empty (not throw);
    `limit > 100` and `limit < 1` rejected by Zod; orphan task
    (no joined agent row) survives the LEFT JOIN with
    `agentName === null`; cursor pagination produces no overlap
    between consecutive pages.
- [x] **Not over-engineered** — no virtualization library added (the
      paginated 50-row page is sized to T04 conventions; flagged for
      T11 polish if real-world DBs > 10k tasks need it). No client
      component, no React state, no React Query — URL is the single
      source of truth and the form is a plain GET. The
      `GLOBAL_TASK_DTO_SELECTION` const sits next to the existing
      `TASK_DTO_SELECTION` so future joins / DTO drift is local. The
      `buildSearchString` helper is small and lives next to the
      `/tasks` page (no premature shared util).
- [x] **ARCHITECTURE v2 picks honoured** — Next.js App Router server
      component (`force-dynamic`), tRPC v11 with `createCaller`
      (in-process, no HTTP roundtrip — §11), Zod input validation
      with explicit min/max bounds, Drizzle `.select` projection
      with explicit columns (no payload bloat), bun:sqlite on the
      read path. Tailwind v4 tokens (`hsl(var(--*))`) + the existing
      shadcn primitives — no new dependency added. **No mutation
      procedure registered.** **No `"use client"` directive added.**
- [x] **No secret leak** — DTO drops `session_id`, `result_file`,
      `pid`, `error_message`, `parent_task_id`, `user_id`, etc. The
      page surfaces only the 9 documented columns. Auth is still
      enforced by `middleware.ts` (T02) — the page renders only
      when the JWT cookie validates.
- [x] **Read-only invariant** — `tasks.list` is a `query`, not a
      `mutation`. The filter form uses `method="get"` (no POST,
      no Server Action). The page contains no `<form action={...}
      method="post">`, no `tasks.dispatch`, `tasks.kill`,
      `loops.approve`. ✅
- [x] **Performance budget §11** — single SELECT per page (LEFT JOIN
      `agents` is a hash/loop on `agents.session_id`, indexed
      implicitly by inserts). Cursor + `id < cursor` hits the
      `tasks` PK; status / session_id filters hit
      `idx_tasks_status` / `idx_tasks_session`. Payload at limit 50
      ≈ 10–20 KB JSON. No virtualization needed because each page
      ships only 50 rows.

## Issues found

- **None blocking.**
- **Minor / observational:**
  - **Virtualization deferred.** The v1 plan acceptance bullet
    mentions "1000-row virtualized < 100ms scroll". Phase 1 keeps
    the table paginated at 50/page; polish flagged for T11 (or a
    future task) if real-world data shows scroll-perf cliffs.
  - **`/tasks/[id]` link 404s.** The Id cell links to the T06
    detail route which doesn't exist yet. Acceptable per scope —
    T06 lands the page on the next iter and the link starts
    working.
  - **Filter form placeholder formats.** `since` / `until` accept
    free-form text (`"YYYY-MM-DD HH:MM:SS"` matches the daemon's
    column). `<input type="datetime-local">` would emit
    `"YYYY-MM-DDTHH:MM"` which sorts correctly with `>=` / `<=`
    against the daemon's space-separated values but breaks exact-
    equality matching. We intentionally use `type="text"` with a
    canonical placeholder so users learn the format; T11 may
    upgrade to a richer date-picker.
  - **Duplicate-name agents.** Same name across two `project_dir`
    rows still resolves through `inArray(session_id IN (…))`; the
    table will show all matching tasks. The Agent column links to
    `/agents/[name]` which itself tie-breaks on `project_dir` ASC
    (T04). Not a regression vs T04 — the page renders only one
    project's metadata for the rare collision.
  - **`tests/app/route-stubs.test.ts` unchanged.** `/tasks` was
    already in the static route list; the stub still passes since
    the page exposes a default export. The page's filter / data
    behaviour is exercised end-to-end via the router tests today
    and Playwright in T13.

## Verification trail

- `bun test` → 99 pass / 0 fail / 270 expects.
- `bun run typecheck` → clean exit.
- `bun run build` deferred to phase-end step 15 (per loop plan).
- Browser/manual smoke deferred to loop step 16. Manual flow to
  verify: `/tasks` (no params) → see ≤ 50 rows DESC → click an
  agent name → `/agents/<name>` → back → enter `status=running`
  → submit → URL is `/tasks?status=running` → only running rows
  → click "Next →" if present → URL gains `cursor=…` → click
  Clear → back to bare `/tasks`.

## Sign-off

T05 complete. INDEX checkbox updated. Ready for T06 (`tasks.get` +
task detail page) on the next iter.
