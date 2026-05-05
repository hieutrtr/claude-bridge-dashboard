# P1-T04 — `agents.get` + Agent detail page (Tasks tab only)

> Phase 1 / Iter 5 of the loop. Builds on T01 (shell), T02 (auth),
> T03 (`agents.list` + grid).

## Source plan reference

- v1 IMPLEMENTATION-PLAN §Phase 1, item **P1-T4**:
  - "**`agents.get` + Agent detail page** · Tab `Tasks` (default), `Memory`,
    `Cost`. Ở phase này chỉ implement tab Tasks."
  - "Acceptance: click card từ T3 → `/agents/[name]` hiển thị 50 task gần
    nhất, paginated."
- v2 ARCHITECTURE.md §0 — v1 sections still applicable.
- v1 ARCHITECTURE.md sections to read **before coding**:
  - **§3 (data model)** — `agents` PK is `(name, project_dir)`; `tasks.session_id`
    FKs `agents.session_id ON DELETE CASCADE`. `tasks.created_at` /
    `started_at` / `completed_at` are TEXT timestamps.
  - **§4.1 `agents.*`** — `agents.get({ name })` → `Agent | null`. Other
    procedures (`memory`, `status`, `stream`) belong to T08/T10.
  - **§4.2 `tasks.*`** — `tasks.list({ sessionId?, status?, limit?, cursor? })`
    `query → paged`. T04 only needs the agent-scoped filter; T05 owns the
    full global table + URL-synced filters.
  - **§11 perf budgets** — DB query p95 < 50ms (10k tasks paged 50);
    First Load JS < 200KB.

## Scope

In: server-component page at `/agents/[name]` rendering a tab strip
(Tasks active, Memory + Cost placeholder), 50 most-recent tasks for the
agent, cursor-based pagination (id-descending), wired `<Link>` from the
T03 grid cards.

Out: Memory tab content (T10), Cost tab content (T09), task detail click-
through (T06), real-time SSE updates (T08), task filtering/sorting (T05),
shared `<Tabs>` shadcn primitive (defer until ≥ 2 routes need it — T10
or later).

## Acceptance criteria

1. `agents.get({ name })` tRPC query returns the full DTO for the named
   agent (or `null` if no row matches). When two agents share a name in
   different `project_dir` columns, return the lexicographically first
   `project_dir` row and document the tie-break in the procedure comment.
2. `tasks.listByAgent({ agentName, limit?, cursor? })` returns
   `{ items: AgentTaskRow[], nextCursor: number | null }`:
   - `limit` defaults to 50, max 100, validated by Zod.
   - `cursor` is the lowest task `id` returned by the previous page;
     omitted on first page.
   - Items ordered by `id DESC` (most recent first).
   - `nextCursor` = lowest id of returned items if exactly `limit` rows
     came back; otherwise `null`.
   - Joins `agents.session_id` to scope by name; if the agent name maps
     to multiple sessions (rare), include tasks from any of them.
   - `AgentTaskRow` projects: `id`, `prompt`, `status`, `costUsd`,
     `durationMs`, `channel`, `createdAt`, `completedAt`.
3. New page `/agents/[name]/page.tsx` (App Router dynamic segment):
   - Calls `agents.get` server-side via `createCaller` — 404 (Next.js
     `notFound()`) if `null`.
   - Header: agent name, project dir, status badge (reuse
     `agentStatusBadge`), model.
   - Tab strip: `Tasks | Memory | Cost`, active state via `?tab=` query
     param (default `tasks`). Memory + Cost render a stub Card noting
     "Coming in T10/T09".
   - Tasks tab body: table with columns Id / Status / Prompt (truncated
     to 80ch) / Channel / Cost / Duration / Created. Empty state for 0
     tasks. "Next →" link uses `?cursor=…&tab=tasks`; hidden when
     `nextCursor` is null.
4. T03 grid cards become `<Link>`s to `/agents/[name]` (encoded with
   `encodeURIComponent`). Hover affordance via Tailwind ring/border;
   keyboard accessible (focus-visible ring).
5. Read-only invariant: zero mutation procedures, zero file writes,
   zero `bridge_dispatch`.

## TDD plan

### Unit / integration (`bun test`)

**`tests/server/agents-router.test.ts`** (extend):
1. `agents.get` returns null on empty DB.
2. `agents.get` returns the matching agent DTO with the same six fields
   `agents.list` projects.
3. `agents.get` returns null when no row has the given name.
4. `agents.get` tie-breaks on `project_dir` ascending when two rows share
   a name.
5. (Optional) `agents.get` projects the same DTO shape as `list` (key
   parity test).

**`tests/server/tasks-router.test.ts`** (new file):
1. `tasks.listByAgent` returns `{items: [], nextCursor: null}` when no
   tasks match.
2. Ordering: returns `id DESC`.
3. Limit defaults to 50; cap of 100 enforced.
4. `cursor` filter: returns only tasks with `id < cursor`.
5. `nextCursor` is the lowest id of the page when `items.length === limit`;
   otherwise `null`.
6. Cross-agent isolation: tasks for other agents (different `session_id`)
   excluded.
7. DTO projection: `AgentTaskRow` keys are exactly the documented eight.
8. (Optional) Two sessions sharing a name still surface both sessions'
   tasks in the same call.

**`tests/lib/task-status.test.ts`** (new file):
1. Map each documented status (`pending`, `running`, `done`, `failed`,
   `killed`, `queued`) → variant + label.
2. `null` and unknown values → "Unknown" / `unknown` variant.

**`tests/app/route-stubs.test.ts`** — does NOT need updating; the dynamic
route is parameter-bound and not in the static list. (We don't add a
runtime test that imports `app/agents/[name]/page.tsx` because Next.js
needs `params` — covered indirectly via the data-layer tests.)

### Component / browser

Skipped at this layer — no jsdom setup in the repo. The Playwright spec
in T13 will navigate `/agents → click card → /agents/[name] → see tasks`.

## Notes / open questions

- **Agent name uniqueness in URL.** Schema PK is `(name, project_dir)`,
  so technically two agents can share `name`. We tie-break on
  `project_dir ASC` and document. If users hit this in practice, T11 can
  add a disambiguation prompt; not blocking T04.
- **Cursor vs offset.** Cursor (id-DESC, `id < ?`) is stable under
  inserts and matches the perf budget §11 comment for `tasks.list`. We
  do NOT support a "Prev" link in T04 — flagged for T11 polish.
- **`AgentTaskRow.prompt`** — full text returned; truncation is a render
  concern. For very long prompts (~hundreds of KB) this could bloat
  payloads; T05 will introduce a server-side truncation in the global
  list. T04 keeps it simple per the read-only spirit.
- **Tabs without a shared primitive.** Inline button-style links suffice
  for 3 tabs. A real `<Tabs>` primitive (Radix or hand-rolled) lands in
  T10 once Memory tab actually has content.
- **Costs / duration formatting** — render raw (`$0.0123`, `1234ms`).
  Pretty formatting is T11.
