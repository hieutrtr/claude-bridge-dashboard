# P1-T10 — Memory tab (read-only)

> Phase 1 / Iter 11 of the loop. Builds on T04 (`/agents/[name]` agent
> detail page) — replaces the Memory tab placeholder with a real
> server-rendered view of the agent's auto-memory directory.

## Source plan reference

- v1 IMPLEMENTATION-PLAN.md §Phase 1, item **P1-T10**:
  - "**Memory tab (read-only)** · Render markdown file
    `~/.claude/projects/.../memory/MEMORY.md` của agent."
  - "Acceptance: file không tồn tại → empty state 'Chưa có memory';
    có → render đẹp."
  - "Deps: P1-T4. Risk: thấp."
- v2 ARCHITECTURE.md §0 — v1 sections still apply.
- v1 ARCHITECTURE.md sections to read **before coding**:
  - **§4.1 `agents.*`** — surface lists
    `agents.memory({ name }) // query → { memoryMd: string, files: string[] }`.
    The wire shape is `(memoryMd, files)`; we extend with the same
    sentinel pattern as `tasks.transcript` (`dirMissing`,
    `fileMissing`, `fileTooLarge`, `fileBytes`,
    `memoryMdTruncated`) so the page can render banners instead of
    crashing when the directory is absent or the file blows past
    the markdown byte cap.
  - **§10 Security — XSS row**: "transcript / result render bằng
    `react-markdown` + sanitize HTML allowlist (`rehype-sanitize`)".
    `MEMORY.md` is also untrusted markdown (the model edits it
    autonomously) — reuse `MARKDOWN_REHYPE_PLUGINS` from T06 + same
    `MARKDOWN_BYTE_LIMIT = 500_000` byte cap.
  - **§3 data model — `agents`**: project_dir is the join key for
    locating the on-disk memory directory. The slug rule is the
    same as the transcript surface (T07): every `/` in
    `agents.project_dir` becomes `-`, anchored under
    `<CLAUDE_HOME>/projects/<slug>/memory/`. We reuse
    `projectSlug` from `src/lib/transcript.ts` rather than
    inventing a new one.
  - **§11 perf budgets** — DB query p95 < 50ms. Memory read is
    bounded I/O: one `agents.get(name)` style row + `existsSync`
    + `readdirSync` (capped) + `readFileSync` of one ≤ 500 KB
    file. Comfortably under budget.

## Scope

In:
- New tRPC query `agents.memory({ name })` in `agentsRouter`:
  - Zod input: `name: z.string().min(1)`.
  - Resolves the agent via the same name → row(s) lookup as
    `agents.get` (tie-break on `project_dir ASC` for cross-project
    name collisions; consistency with T04).
  - Returns `null` for unknown agent (mirrors `agents.get`).
  - Computes `dirPath` via
    `<CLAUDE_HOME>/projects/<projectSlug(projectDir)>/memory/`.
  - When the directory is missing on disk → returns
    `{ projectDir, dirPath, dirMissing: true, fileMissing: true,
       fileTooLarge: false, fileBytes: 0, memoryMd: null,
       memoryMdTruncated: false, files: [] }`.
  - When the directory exists but `MEMORY.md` is missing → returns
    `dirMissing: false, fileMissing: true` plus `files: [...]` of
    sibling `*.md` filenames (so a power user can see their notes
    even when no top-level index exists yet).
  - When `MEMORY.md` is bigger than 500_000 bytes → returns
    `fileTooLarge: true, memoryMd: null, fileBytes: <actual>`. We
    do not stream a partial — the user can open the file directly
    via the `dirPath` pointer.
  - Otherwise → reads the file, byte-clips to `MARKDOWN_BYTE_LIMIT`
    (defence in depth: the cap is also the file-too-large
    threshold, so this only triggers if the file is exactly at
    the boundary), sets `memoryMdTruncated` accordingly, and
    populates `files` with the directory listing.
  - `files` is `readdirSync(dirPath)` filtered to entries ending in
    `.md`, sorted, capped at **200** filenames. (200 is generous —
    the user's actual directory has ~6 entries; the cap exists so
    a misuse like "memory dir polluted with thousands of files"
    can't slow the procedure.)
  - **Read-only**: `query`, no `mutation`. No filesystem writes —
    `existsSync`, `statSync`, `readdirSync`, `readFileSync` only.
- Update `app/agents/[name]/page.tsx`:
  - Replace `MemoryTabPlaceholder` with a real `MemorySection`
    server component.
  - Only fetch `agents.memory` when the active tab is `memory`
    (parallel to the `tab === "tasks"` guard for `tasks.listByAgent`)
    — keeps the Tasks-tab page render free of an unused round-trip.
  - Render markdown via `<ReactMarkdown rehypePlugins={MARKDOWN_REHYPE_PLUGINS}>`,
    same wrapper as the Result section in T06.
  - Banners for `dirMissing` / `fileMissing` / `fileTooLarge` /
    `memoryMdTruncated`.
  - Sibling files surface as a small list under the markdown body:
    `<dirPath><br/>MEMORY.md, foo.md, bar.md`. This satisfies the
    v1 §4.1 spec ("files: string[]") without requiring per-file
    routes — clicking a sibling file would be a Phase 2 polish.
- Tests:
  - Extend `tests/server/agents-router.test.ts` with a new
    `describe("agents.memory")` block that materialises a memory
    fixture under a tmp `CLAUDE_HOME` and asserts wire shape.
  - Optional smoke test: `tests/app/agent-detail-memory.test.ts`
    that imports the page module + asserts no mutation handler is
    exported. (Mirrors the Phase 1 read-only guard pattern from
    T08/T09 page tests.)

Out:
- Editing memory files. Read-only invariant — Phase 2 introduces
  the `agents.setMemory` / `agents.appendMemory` mutations.
- Per-file routes (e.g. `/agents/[name]/memory/[file]`). The
  sibling-file list is informational only; clicking a name would
  open a new view that doesn't exist yet. Phase 2 polish.
- Recursive directory walks. We list one level only — the
  observed memory layout is flat.
- Live updates as the agent rewrites memory mid-session. Phase 2
  + SSE; same constraint as T07 transcript live tail.
- Search across memory files. Future polish.
- Frontmatter parsing / "name + description + type" rendering. The
  user already sees the rendered markdown which surfaces those
  fields if the file uses them; a structured pretty-printer is
  Phase 2 polish.

## Acceptance criteria

1. `agents.memory({ name })` returns `null` for an unknown agent
   (no throw).
2. `agents.memory({ name })`:
   - When the memory directory is missing on disk → returns
     `{ ..., dirMissing: true, fileMissing: true, files: [],
        memoryMd: null }`. `dirPath` is still populated for debug.
   - When the directory exists but `MEMORY.md` is missing →
     returns `dirMissing: false, fileMissing: true, memoryMd: null,
     files: [<sibling .md filenames>]`.
   - When `MEMORY.md` exists and is ≤ 500_000 bytes → returns
     `dirMissing: false, fileMissing: false, fileTooLarge: false,
     memoryMd: <content>, memoryMdTruncated: false,
     fileBytes: <actual>, files: [<filenames sorted asc>]`.
   - When `MEMORY.md` exists and is > 500_000 bytes → returns
     `fileTooLarge: true, memoryMd: null, fileBytes: <actual>`.
3. `files` lists only `*.md` filenames, sorted ascending, capped
   at 200. Non-md entries (sub-dirs, dotfiles, `.txt`) are
   filtered out.
4. The procedure is registered with `publicProcedure.query(...)`
   — never `.mutation(...)`. Performs zero filesystem writes.
5. Cross-project name collision: `agents.memory({ name })` returns
   the row whose `project_dir` is alphabetically smallest, same
   tie-break as `agents.get` from T04.
6. `agents.memory({ name: "" })` rejects via Zod (the page
   guarantees a non-empty name from the URL segment).
7. Page `/agents/[name]?tab=memory`:
   - Renders the memory markdown through `MARKDOWN_REHYPE_PLUGINS`
     (XSS-safe — no `<script>` execution).
   - Renders an empty-state message when `dirMissing` or
     `fileMissing` is true ("No memory recorded for this agent
     yet" + the expected on-disk path so the user can create the
     file themselves).
   - Renders a "file too large" banner with the actual byte size
     when `fileTooLarge` is true.
   - Lists sibling `*.md` filenames under the markdown body.
   - Does not emit a `<form action method="post">`, no Server
     Action, no mutation procedure call.
8. `bun test` passes; `bun run typecheck` clean.

## TDD plan

### Integration (`tests/server/agents-router.test.ts`) — extend

Add `describe("agents.memory")` block with a `writeMemoryFixture`
helper that materialises files under
`<CLAUDE_HOME>/projects/<slug>/memory/`. Override
`process.env.CLAUDE_HOME` to a temp dir before each test.

1. Returns `null` for an unknown agent name (no throw).
2. Returns `dirMissing: true, fileMissing: true, files: []` when
   the agent exists but the memory directory is absent.
3. Returns `dirMissing: false, fileMissing: true,
   files: [<sibling .md>]` when the directory exists but
   `MEMORY.md` is missing.
4. Returns `memoryMd: <content>, files: ['MEMORY.md', ...]` when
   `MEMORY.md` is present and small.
5. Returns `fileTooLarge: true, memoryMd: null,
   fileBytes: <actual>` when `MEMORY.md` exceeds 500_000 bytes.
6. `files` filters out non-`.md` entries (sub-dirs, dotfiles,
   `.txt`).
7. `files` is sorted ascending.
8. `files` is capped at 200 entries.
9. Cross-project name collision: tie-break on `project_dir ASC`
   matches `agents.get`.
10. Read-only — `agents.memory` is registered with
    `.query(...)`, not `.mutation(...)` (asserted via the
    `appRouter._def.procedures.agents.memory._def.type` check
    used in T07/T08 tests).

### Page smoke test (`tests/app/agent-detail-memory.test.ts`) — new

11. Page module default export is a function (renders a server
    component). No `POST` / `PUT` / `PATCH` / `DELETE` named
    exports. Mirrors the read-only guard from T09's page test.

### Component / browser

Skipped at this layer (no jsdom). Playwright in T13 will exercise
the full `/agents/[name]?tab=memory` flow. Manual note in the
review listing the steps to verify in browser.

## Notes / open questions

- **Why a flat directory walk?** The observed Claude Code memory
  directory layout is flat — `MEMORY.md` plus sibling per-topic
  `.md` files. If a future Claude Code release introduces nested
  sub-folders, we add a recursive walk + tree renderer.
- **Why the 500_000-byte cap?** Mirrors `MARKDOWN_BYTE_LIMIT` from
  T06 (`tasks.result_summary`). The same cap is applied to all
  untrusted markdown that the dashboard renders inline so the
  client-side `react-markdown` walker has a predictable upper
  bound.
- **`CLAUDE_HOME` env var.** Same default as the transcript
  surface from T07: `process.env.CLAUDE_HOME ?? <homedir>/.claude`.
  Tests override it to the temp dir.
- **Why surface `dirPath` in the wire?** It's the same scope
  decision as T07's `filePath` — the path is constrained to a
  user-owned location on the same host (no `..` injection
  possible because it's computed from `agents.project_dir`, not
  from user input). Surfacing it lets the user open the file
  directly when the dashboard truncates. Document in the review.
- **Why no per-file route?** The v1 spec exposes
  `files: string[]` but doesn't define a `agents.memoryFile({
  name, file })` procedure. Surfacing the filenames as
  informational text matches the spec letter; clickable per-file
  views are Phase 2 polish.
- **Why fetch only when the tab is active?** Same pattern as
  `tasks.listByAgent` in T04 — avoids one in-process tRPC call
  per page render when the user is on Tasks/Cost. Keeps the
  page-load budget tight per ARCH §11.
