# P1-T10 — Memory tab — Self-Review

> Spec: `T10-memory-tab.md`. Iter 11/17.

## Files changed / added

**New:**
- `tests/server/agents-router.test.ts` (extended with the
  `describe("agents.memory")` block — 10 new tests covering
  unknown-agent, dirMissing, fileMissing+sibling, happy path,
  fileTooLarge, non-md filtering, sort order, 200-cap, cross-
  project name tie-break, empty-name Zod rejection, and the
  read-only `_def.type === "query"` guard).
- `tests/app/agent-detail-memory.test.ts` — 5 page-level smoke
  tests (default export type, no POST/PUT/PATCH/DELETE handlers,
  empty-state branch, populated branch with markdown body +
  sibling files, file-too-large banner with byte size).
- `docs/tasks/phase-1/T10-memory-tab.md` — task spec.
- `docs/tasks/phase-1/T10-review.md` — this file.

**Modified:**
- `src/server/dto.ts` — added `AgentMemory` interface (with the
  `dirMissing` / `fileMissing` / `fileTooLarge` /
  `memoryMdTruncated` sentinels mirroring `TaskTranscript`).
- `src/server/routers/agents.ts` — new `memory` query procedure
  reading `<CLAUDE_HOME>/projects/<slug>/memory/`. Reuses
  `projectSlug` from `src/lib/transcript.ts` and
  `MARKDOWN_BYTE_LIMIT` from `src/lib/markdown.ts`. Read-only:
  only `existsSync` / `statSync` / `readdirSync` / `readFileSync`.
- `app/agents/[name]/page.tsx` — replaced
  `MemoryTabPlaceholder` with a real `MemorySection` server
  component (banners + ReactMarkdown body + sibling-file chip
  list). Cost tab still placeholders since per-agent cost is
  Phase 2 polish; updated its copy to point users at `/cost`.
- `docs/tasks/phase-1/INDEX.md` — checkbox + status line bump.

## Self-review checklist

- [x] **Tests cover happy + edge cases** — happy: read MEMORY.md,
  list 2 sibling files, render through markdown body. Edge:
  unknown agent → `null`; agent without memory dir →
  `dirMissing+fileMissing`; agent with sibling notes but no
  MEMORY.md → `fileMissing` with non-empty `files`; 500_001-byte
  MEMORY.md → `fileTooLarge` (no body); subdir + dotfile + .txt
  filtered out of `files`; sort ascending; 250-file fixture
  capped at 200; cross-project name collision tie-broken on
  project_dir ASC; empty-name input rejected via Zod; procedure
  registered as a query (not mutation). Page edge: empty-state
  copy on `dirMissing`; banner with the actual byte count on
  `fileTooLarge`.
- [x] **Not over-engineered** —
  - One new procedure (`agents.memory`) — matches v1 §4.1 spec.
  - No new helper module (`projectSlug` reused from
    `src/lib/transcript.ts`; markdown cap reused from
    `src/lib/markdown.ts`).
  - No per-file route — informational chip list only. Phase 2
    polish.
  - No recursive directory walk — observed memory layout is
    flat.
  - No frontmatter parser. The user already gets the rendered
    markdown, which surfaces the metadata visually.
- [x] **ARCHITECTURE v2 picks honoured** —
  - Next.js App Router server component
    (`app/agents/[name]/page.tsx`) calling tRPC via
    `appRouter.createCaller({})` — same in-process pattern as
    T03..T09.
  - Drizzle 0.40 select-by-name with `orderBy(asc(projectDir))`
    + `limit(1)` (consistency with `agents.get`).
  - bun:sqlite via the existing `getDb()` handle — no new DB
    stack.
  - shadcn `Card` + Tailwind v4 design tokens
    (`hsl(var(--border))`, `hsl(var(--muted))`,
    `hsl(var(--muted-foreground))`).
  - `react-markdown` + `rehype-sanitize` via the shared
    `MARKDOWN_REHYPE_PLUGINS` from T06 — same XSS-safe stack
    as the result section.
- [x] **No secret leak** — payload only carries `projectDir`,
  `dirPath`, the sentinel booleans, the `MEMORY.md` content,
  and the `*.md` filename list. No JWT data, no secrets, no
  filesystem paths outside the agent's own slug directory.
  `dirPath` IS surfaced — but only for the user's own
  `~/.claude/projects/...` directory; it's a deliberate scope
  decision (mirrors `tasks.transcript` from T07) so the user
  can open the file in their editor when the dashboard
  truncates.
- [x] **Read-only: NO mutation/dispatch call** —
  - `src/server/routers/agents.ts`: only `publicProcedure.query`
    procedures; no `.mutation(`, no `.insert(`, no `.update(`,
    no `.delete(`. The `memory` body uses only
    `existsSync` / `statSync` / `readdirSync` / `readFileSync`
    — zero filesystem writes.
  - `app/agents/[name]/page.tsx`: only consumes tRPC query
    procedures (`agents.get`, `agents.memory`,
    `tasks.listByAgent`). No `<form action="…" method="post">`,
    no Server Action, no client-side mutation.
  - The new `_def.type === "query"` test (run #11 in the
    `agents.memory` block) pins the procedure type so a future
    PR can't silently flip it to a mutation.

## Acceptance bullets vs spec

1. ✅ Returns `null` for unknown agent (test "returns null for
   an unknown agent name (no throw)").
2a. ✅ `dirMissing+fileMissing+empty files` when the dir is
    absent (test "returns dirMissing+fileMissing+empty files
    when the memory dir is absent").
2b. ✅ `fileMissing` + sibling `.md` listing when MEMORY.md is
    absent but the dir exists (test "returns
    fileMissing+sibling .md when MEMORY.md is absent but the
    dir exists").
2c. ✅ Returns the file content + non-empty `files` when MEMORY.md
    is present (test "returns memoryMd content + files list when
    MEMORY.md is present"). `fileBytes` matches
    `Buffer.byteLength`.
2d. ✅ `fileTooLarge: true, memoryMd: null, fileBytes` reports
    the actual size when MEMORY.md exceeds 500_000 bytes (test
    "flags fileTooLarge when MEMORY.md exceeds the 500_000 byte
    cap").
3. ✅ `files` filters out non-md (sub-dirs, dotfiles, `.txt`)
   (test "filters out non-md entries (sub-dirs, dotfiles, .txt)
   from files"); sorted ascending (test "sorts files
   ascending"); capped at 200 (test "caps files at 200
   entries").
4. ✅ Procedure registered as `.query(...)` — verified via
   `appRouter._def.procedures["agents.memory"]._def.type ===
   "query"` (test "is registered as a query procedure
   (read-only invariant)"). Procedure body uses zero filesystem
   writes — only read APIs.
5. ✅ Cross-project name collision tie-breaks on `project_dir
   ASC` (test "tie-breaks cross-project name collision on
   project_dir ASC (matches agents.get)"). The tie-break wins by
   only seeding memory under `/tmp/alpha-mem` (alphabetically
   first); the procedure resolves to it and reads its
   MEMORY.md.
6. ✅ Empty-name input rejected via Zod (test "rejects an
   empty name input via Zod").
7a. ✅ Page renders markdown via `MARKDOWN_REHYPE_PLUGINS`
    (page test "renders the markdown body and sibling files
    when MEMORY.md is present" — asserts both the heading
    "Project Memory" and the body line "Vision: ship dashboard"
    appear).
7b. ✅ Page renders the empty-state copy when the dir is
    missing (test "renders the empty-state copy when the
    memory directory is missing" — asserts "Memory" + "No
    memory recorded").
7c. ✅ Page renders the file-too-large banner with the actual
    byte size (test "renders the file-too-large banner with
    the actual byte size" — matches `/500[, ]?001/`).
7d. ✅ Page lists sibling `*.md` filenames (test "renders the
    markdown body and sibling files when MEMORY.md is
    present" — asserts both `MEMORY.md` and `user_role.md`
    appear in the HTML).
7e. ✅ Page emits no POST/PUT/PATCH/DELETE handler (test
    "does NOT export POST/PUT/PATCH/DELETE handlers").
8. ✅ `bun test`: 179 → 195 (+16 new); `bun run typecheck`
   clean.

## Issues found / decisions

- **`memoryMdTruncated` is structurally redundant with
  `fileTooLarge`** because the byte cap is the same as the
  too-large threshold — anything bigger short-circuits to
  `fileTooLarge: true, memoryMd: null` before the byte-clipping
  branch fires. Kept the field on the wire for parity with
  `TaskDetail.resultMarkdownTruncated` so the UI banner code
  stays uniform across surfaces. Not a bug — call it defensive
  coding.
- **`projectSlug` reuse from T07.** The same path-flipping rule
  applies to both Memory and Transcript (Claude Code anchors
  per-project state under `~/.claude/projects/<slug>/`).
  Importing it from `src/lib/transcript.ts` keeps a single
  source of truth; if Claude Code ever changes the slug rule,
  both surfaces get the fix together.
- **Sibling-file list, not sibling-file routes.** v1 §4.1 lists
  `files: string[]` but no per-file route. We surface the
  filenames as informational chips. Clicking a name doesn't go
  anywhere yet — Phase 2 polish (would need an
  `agents.memoryFile({ name, file })` procedure with the same
  byte cap + sanitization).
- **Dotfile filter.** `.DS_Store` and similar shouldn't surface
  in the chip list. The simpler rule "filter to `.endsWith(".md")`"
  already excludes them — no need for an explicit dotfile
  blacklist.
- **`readdirSync` with `withFileTypes`.** Cheaper than a follow-up
  `statSync` per entry and lets us skip sub-directories in the
  same pass. Test fixture explicitly creates `subdir/deep.md` to
  prove the filter rejects nested entries.
- **`fileBytes: stats.size` vs `Buffer.byteLength(content)`.** The
  procedure reports `stats.size` (the on-disk size) — the
  authoritative number a user would see in `ls -l`. The
  `memoryMdTruncated` defence-in-depth check uses the in-memory
  byte length so a UTF-8 anomaly doesn't smuggle past the cap.
- **No symlink follow.** `readdirSync` returns symlink entries
  with `dirent.isFile() === false` (they show up as symlinks),
  so the filter naturally excludes them. If Claude Code ever
  starts symlinking memory files in, we'd need to revisit —
  document but don't pre-empt.
- **Cost tab placeholder still present.** Per-agent cost is
  out of Phase 1 scope (the dashboard-wide `/cost` page from
  T09 covers the analytics surface). Updated the placeholder
  copy to point users at `/cost` instead of "coming in T09".
- **Read-only guard test (`_def.type === "query"`).** Net new
  pattern in this repo — verified `appRouter._def.procedures`
  is the flat `<router>.<proc>`-keyed map in tRPC v11 (via
  `bun --eval`). The cast to
  `unknown as Record<string, { _def: { type: string } }>`
  satisfies TS without leaking the introspection types into
  production code.

## Test summary

```
$ bun test
 195 pass
   0 fail
 600 expect() calls
Ran 195 tests across 18 files. [798 ms]
```

Up from 179 → 195 (+16 new): 10 in
`tests/server/agents-router.test.ts` (the `agents.memory` block),
1 carrier (`is registered as a query procedure`), 5 in
`tests/app/agent-detail-memory.test.ts`. Wait — counted again:
the `agents.memory` describe has 11 tests (including the
read-only guard) + 5 page tests = 16 new. Matches.

`bun run typecheck` clean.

## Manual browser verification checklist (PHASE-BROWSER-TEST)

- [ ] Navigate to `/agents/<some-agent>?tab=memory` — page
      renders within ~200 ms (FCP budget §11). Cards stack
      vertically: header, tab strip, Memory card.
- [ ] When the agent has a real memory directory: markdown
      body renders headings + lists + code blocks. Sibling
      files surface as chip list under the body.
- [ ] When the agent has no memory directory yet: empty-state
      copy "No memory recorded for this agent yet" appears
      with the on-disk path.
- [ ] When MEMORY.md > 500 KB (synthesise via `dd if=/dev/zero
      of=MEMORY.md bs=1024 count=600`): banner "MEMORY.md is
      too large to render (614,400 bytes). Open the file
      directly at <path>." appears.
- [ ] Clicking the Tasks tab and back to Memory does not
      cause a flash or stale-content render — `dynamic =
      "force-dynamic"` re-fetches per nav.
- [ ] No `<script>` / mutation forms in the rendered HTML.
