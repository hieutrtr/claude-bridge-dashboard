# P1-T06 — `tasks.get` + Task detail page

> Phase 1 / Iter 7 of the loop. Builds on T01 (shell), T02 (auth),
> T03/T04 (agents), T05 (`tasks.list` + global Tasks page). The Id
> column on the global table already links to `/tasks/[id]` — T06
> lands the route so those links resolve.

## Source plan reference

- v1 IMPLEMENTATION-PLAN §Phase 1, item **P1-T6**:
  - "**`tasks.get` + Task detail page** · Header (status, cost,
    duration), Prompt section, Result Markdown render, metadata
    sidebar (turns, model, exit_code, channel)."
  - "Acceptance: render `result_file` < 500KB không vỡ; long prompt
    collapse được."
  - "Deps: P1-T5. Risk: thấp — Markdown XSS đã sandbox."
- v2 ARCHITECTURE.md §0 — v1 sections still applicable.
- v1 ARCHITECTURE.md sections to read **before coding**:
  - **§4.2 `tasks.*`** — surface lists `tasks.get({ id }) → query →
    Task & { transcript? }`. We satisfy `Task` only here; the
    `transcript` slice is owned by **T07** (separate procedure
    `tasks.transcript({ id })` plus a tab on the same page) — out
    of T06 scope.
  - **§3 (data model)** — the daemon's `tasks` table carries the
    columns we surface: `id`, `session_id`, `prompt`, `status`,
    `cost_usd`, `duration_ms`, `num_turns`, `exit_code`,
    `error_message`, `created_at`, `started_at`, `completed_at`,
    `model`, `task_type`, `parent_task_id`, `channel`,
    `channel_chat_id`, `channel_message_id`, `result_file`,
    `result_summary`. The detail DTO surfaces a curated subset; we
    explicitly drop `pid`, `user_id`, `result_file` (raw path on
    daemon disk — internal), `reported`, `position`.
  - **§10 Security — XSS row** — "transcript render bằng
    `react-markdown` + sanitize HTML allowlist (`rehype-sanitize`)".
    Result Markdown is the same threat vector (untrusted text from
    the agent's stdout) → use the same sanitization stack.
  - **§11 perf budgets** — single SELECT-by-PK is well under the
    50ms p95 budget. The 500KB result-markdown render acceptance
    bullet is the page-side concern, not the query.

## Scope

In:
- New tRPC query `tasks.get({ id }) → TaskDetail | null`. `null`
  for unknown id (no throw — keeps the not-found render simple).
- DTO `TaskDetail` includes the resolved `agentName: string | null`
  (LEFT JOIN `agents` on `tasks.session_id = agents.session_id`)
  plus the curated column list above. `resultMarkdown` is the
  contents of `result_summary` (a TEXT column the daemon writes
  with the assistant's final message). The on-disk `result_file`
  path is **not** surfaced — read-only invariant: the dashboard
  must not stream a path that the user could trigger on the
  server. We render whatever fits in the column; T07 will read the
  JSONL session file separately for the transcript.
- New page `/tasks/[id]`:
  - Server component, `force-dynamic`.
  - 404 (`notFound()`) when id is non-numeric, ≤ 0, or unknown.
  - Header: id (mono), status badge (reuse `taskStatusBadge`),
    agent link (`/agents/[name]` if agent resolved), cost,
    duration, model, channel, created/started/completed timestamps.
  - Prompt section: `<pre>` block with the full prompt, scrolling
    if long. Per acceptance "long prompt collapse được" — render
    inside a `<details>` element with the first 12 lines visible
    by default, the rest collapsed. No client JS needed —
    `<details>` is native HTML.
  - Result Markdown section: render `resultMarkdown` (when
    present) via `react-markdown` + `rehype-sanitize`. Empty
    state: "No result yet" with subtext explaining `result_summary`
    populates on task completion. Hard-cap at 500KB on the
    server side: if `result_summary` exceeds the cap, surface a
    truncation banner above the rendered markdown so the page
    doesn't hang. This satisfies the v1 acceptance "render
    `result_file` < 500KB không vỡ" — the cap protects the page;
    everything below the cap renders.
  - Metadata sidebar: `numTurns`, `model`, `exitCode`, `channel`,
    `taskType`, `parentTaskId`, `errorMessage`, `agentName`,
    `sessionId`, `createdAt`, `startedAt`, `completedAt`. (We keep
    `sessionId` here because the user already sees agent name +
    project on `/agents/[name]`; this just adds debug context.
    Audit: `sessionId` is not a credential; it's a derived id.)
- Read-only: `tasks.get` is a `query`. Page renders no `<form>`,
  no Server Action, no mutation procedure call.

Out:
- Transcript viewer (T07) — adds a separate `tasks.transcript`
  procedure + tab on this page.
- SSE live updates (T08) — task status badge will go live there.
- Memory tab on the agent detail page (T10).
- Cost analytics (T09).
- Task action buttons (Re-run, Kill, Approve loop step) — Phase 2+
  mutations.

## Acceptance criteria

1. `tasks.get({ id })` is a tRPC **query** (not mutation):
   - Zod input: `id: z.number().int().positive()` — rejects 0,
     negative, non-integer, non-number.
   - Returns `TaskDetail | null`. `null` for unknown id (no throw).
   - LEFT JOIN `agents` on `session_id`; orphaned task surfaces
     with `agentName: null`.
   - DTO drops `pid`, `user_id`, `result_file`, `reported`,
     `position` from the wire payload.
   - `resultMarkdown` is `result_summary` clipped to ≤ 500_000
     bytes (UTF-8 byte length); if clipping happened,
     `resultMarkdownTruncated: true` accompanies it. (Strings the
     UI doesn't render don't go on the wire.)
2. Page `/tasks/[id]`:
   - Resolves the dynamic `[id]` param. If not a positive integer,
     calls `notFound()`. If the procedure returns `null`, calls
     `notFound()`.
   - Renders header with status badge, agent link (if not
     orphaned), cost (`$0.0123` or `—`), duration (`1234ms` or
     `—`), created/started/completed timestamps.
   - Renders prompt inside `<details>` collapsing >12 lines.
   - Renders Result Markdown via `react-markdown` +
     `rehype-sanitize` (default schema). When
     `resultMarkdownTruncated === true`, shows a subdued banner
     above the rendered markdown. When `resultMarkdown === null`
     (or empty), shows the empty state.
   - Renders the metadata sidebar.
3. Read-only invariant:
   - `tasks.get` registered with `publicProcedure.query(...)`.
   - Page emits no mutation calls, no `<form action method="post">`,
     no Server Action.
   - `result_file` on-disk path is never surfaced.

## TDD plan

### Unit / integration (`bun test`)

**`tests/server/tasks-router.test.ts`** — extend with a new
`describe("tasks.get", () => {...})` block. Reuses the existing
`SCHEMA_DDL` + `seedAgents` / `seedTasks` helpers. Add a small
`seedTasksWithDetail` helper (or reuse `seedTasks` with extra cols)
to populate `result_summary`, `num_turns`, `exit_code`, `model`,
`task_type`, `parent_task_id`, `error_message`, `started_at`.

1. Returns `null` for an unknown id (no throw).
2. Returns the task row for a known id, with the curated DTO keys
   exactly (no `pid`, `user_id`, `result_file`, `reported`,
   `position`).
3. Resolves `agentName` via LEFT JOIN `agents`.
4. `agentName === null` for an orphaned task (no joined agents
   row).
5. `resultMarkdown` mirrors `result_summary`.
6. `resultMarkdown === null` when `result_summary` is null.
7. `resultMarkdownTruncated === false` when payload is under 500KB.
8. `resultMarkdownTruncated === true` when payload is ≥ 500KB +
   `resultMarkdown` is clipped to ≤ 500_000 bytes.
9. Zod input rejects `id: 0`, `id: -1`, `id: 1.5`, missing.
10. Surfaces all curated columns: `numTurns`, `exitCode`, `model`,
    `taskType`, `parentTaskId`, `errorMessage`, `startedAt`,
    `sessionId`.

**`tests/app/route-stubs.test.ts`** — `/tasks/[id]` is a dynamic
route; the existing static route loop won't pick it up. We do not
add a stub for it (would force the test to seed a DB and the
route already gets exercised once we add a behavioural test).
Document the deferral in the review.

### Component / browser

Skipped at this layer (no jsdom). Playwright in T13 will exercise:
- Land on `/tasks` → click an Id link → `/tasks/<id>` → see header
  + prompt + result + sidebar.
- Visit `/tasks/999999999` → 404.
- Visit `/tasks/abc` → 404.

### Markdown XSS

The threat is rendered HTML inside `result_summary` (the agent
might output `<script>alert(1)</script>` or `<img onerror=...>`).
`react-markdown` doesn't render raw HTML by default unless we
opt-in with `rehype-raw`; `rehype-sanitize` plus an explicit
allowlist provides defense-in-depth even if a future tweak
enables raw HTML. Add a static check (one test) that imports the
page and verifies the markdown renderer is configured with
`rehypePlugins: [rehypeSanitize]`. Realistically the assertion
lives in a tiny helper module so it's testable without rendering
React (no jsdom in this repo); we ship `src/lib/markdown.ts`
exposing `MARKDOWN_REHYPE_PLUGINS` plus the same sanitization
schema and assert against it.

**`tests/lib/markdown.test.ts`** (new):
1. `MARKDOWN_REHYPE_PLUGINS` includes `rehypeSanitize`.
2. `MARKDOWN_REHYPE_PLUGINS` is non-empty (defensive: a future
   refactor that empties it must trip the test).
3. The exported `MARKDOWN_BYTE_LIMIT` is exactly `500_000` (so the
   page-render and procedure-clip code stay in sync).

## Notes / open questions

- **`react-markdown` + `rehype-sanitize` deps.** Both are pulled
  in for the first time in T06. Versions: latest stable in the
  Next 15 / React 19 ecosystem. The DOM types pin to the
  `@types/react@19` already in `devDependencies`.
- **Markdown bundle weight.** `react-markdown` adds ~30KB gzipped;
  v1 ARCH §11 caps First Load JS at 200KB on `/agents` (the
  landing route). The detail page doesn't share that route's
  bundle and the dashboard already runs server components for
  data fetching, so the markdown vendor only ships when this
  page loads. Acceptable.
- **`<details>` for prompt collapse.** Native HTML — no client
  JS, no `"use client"` directive. Browser handles toggle. Works
  with keyboard. Style with the existing Tailwind tokens.
- **500KB byte cap vs character cap.** v1 acceptance says
  "render `result_file` < 500KB không vỡ". `result_summary` is
  the closest text column to the result file (the daemon
  populates it with the trimmed final message). We cap at
  `500_000` bytes (UTF-8) on the server so the wire payload
  stays bounded; clients still get the full ≤500KB body.
- **No transcript here.** The acceptance bullet about
  "transcript" sits in T07; this page should have a placeholder
  card "Transcript will land in T07" or simply omit the section
  entirely. Decision: omit. Adding a placeholder is dead UI
  the user has to scroll past; T07 introduces it once it
  exists.
- **404 vs empty state.** Unknown task → `notFound()`. The page
  never shows "task not found" inline; Next's 404 chrome owns
  that.
- **`channel_chat_id` / `channel_message_id`.** These are
  Telegram-side ids. The metadata sidebar surfaces them only
  when present; not a security concern (same data the bridge
  daemon already exposes via MCP), but they're noisy so we
  group them into a single "Channel context" line.
- **Decimal cost rendering.** Reuses the T05 convention
  (`$0.0004` to 4dp). T11 polishes.
- **The `/tasks/[id]` Id link from T05** finally resolves with
  this task — note in review that the link's "404 in the
  meantime" caveat from T05 is now closed.
