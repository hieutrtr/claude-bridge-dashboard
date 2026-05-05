# P1-T07 — Transcript viewer (JSONL)

> Phase 1 / Iter 8 of the loop. Builds on T06 (`/tasks/[id]` task
> detail page) — adds a per-task Transcript section that reads the
> Claude Code JSONL session file from disk and renders turn-by-turn.

## Source plan reference

- v1 IMPLEMENTATION-PLAN.md §Phase 1, item **P1-T7**:
  - "**Transcript viewer** · Đọc JSONL session file Claude Code
    (`~/.claude/projects/.../session.jsonl`), render từng turn
    assistant/user/tool."
  - "Acceptance: mở task running → thấy stream live của Claude
    Code; tool_use block render compact."
  - "Deps: P1-T6. Risk: **cao** — format JSONL có thể đổi giữa các
    version Claude Code."
- v2 ARCHITECTURE.md §0 — v1 sections still apply.
- v1 ARCHITECTURE.md sections to read **before coding**:
  - **§4.2 `tasks.*`** — surface lists `tasks.transcript({ id })`
    "query → { lines: TranscriptLine[] } (read result_file)". v1
    framed it as reading `result_file`, but the daemon's
    `result_file` is the *result-summary* path, not the
    Claude-Code-session JSONL. The actual wire we want is the
    session JSONL at `~/.claude/projects/<slug>/<session_id>.jsonl`
    — which is exactly the file Claude Code writes, regardless of
    whether the bridge daemon also captures a `result_file`.
  - **§10 Security** —
    - "transcript render bằng `react-markdown` + sanitize HTML
      allowlist (`rehype-sanitize`)" — already wired in T06; we
      reuse `MARKDOWN_REHYPE_PLUGINS`.
    - The transcript JSONL comes from disk on the same machine, but
      the assistant text inside a turn is still untrusted (might
      include raw HTML / `<script>` tags an agent typed). Render
      assistant `text` blocks via `react-markdown` + sanitize, same
      as the result section. Other content (`thinking`, `tool_use`
      input JSON) goes inside `<pre>` (no markdown / no HTML
      execution).
  - **Risk #3 — JSONL format drift** (v1 §Risks). Mitigation:
    "Version-detect parser, fallback raw text view; pin Claude Code
    minor version trong `package.json` engines; integration test
    mỗi release." We honour the *fallback raw text view* part: any
    line that fails JSON parse, OR has a `type` we don't recognise,
    OR has a content shape we don't recognise, surfaces as a
    `meta`/`raw` turn with the original JSON visible inside a
    collapsed `<details>`. We do **not** pin Claude Code version
    here — that's a Phase-2 decision.
  - **§11 perf budgets** — DB query p95 < 50ms. The JSONL read is
    bounded I/O (file system read) plus a single `tasks.get` style
    join; we cap file size at **5 MB** and parsed-turn count at
    **500 turns** (most recent) so the wire payload stays bounded.
    A 5 MB JSONL with 1000 lines parses in well under 50ms on a
    Bun runtime.

## Scope

In:
- New helper module `src/lib/transcript.ts` — pure / IO-free:
  - `projectSlug(projectDir: string): string` — Claude Code's path
    convention is `~/.claude/projects/<slug>/`, where `<slug>` is
    the absolute project dir with every `/` replaced by `-`. So
    `/Users/foo/bar` → `-Users-foo-bar`. No further escaping
    (verified by inspecting `~/.claude/projects/` on the host).
  - `transcriptPath(home: string, slug: string, sessionId: string):
    string` — joins `home/projects/<slug>/<sessionId>.jsonl`.
  - `parseTranscriptLine(line: string): TranscriptTurn` — parses
    one JSONL line into a turn. Unknown / unparseable lines surface
    as `{ kind: "raw" | "meta", ... }`.
  - `parseTranscript(content: string, opts: { maxTurns: number }):
    TranscriptParseResult` — splits on `\n`, filters empty lines,
    parses each, then keeps the **last `maxTurns` turns** (the most
    recent ones — what the user wants to see for a running task).
    Returns `{ turns, totalLines, truncated }`.
- New tRPC query `tasks.transcript({ id })` in `tasksRouter`:
  - Zod input: `id: z.number().int().positive()`.
  - Join `tasks` → `agents` to resolve `session_id` + `project_dir`.
  - Returns `null` for unknown task id (mirrors `tasks.get`).
  - Returns
    `{ filePath, fileMissing: true, ... }` when the JSONL doesn't
    exist on disk (legitimate: orphan task, daemon ran on a
    different host, file deleted).
  - Returns
    `{ filePath, fileMissing: false, fileBytes, totalLines, turns,
       truncated, fileTooLarge }` on success.
  - File-size cap: **5 MB**. If the file is bigger, sets
    `fileTooLarge: true`, returns no turns. (We don't truncate
    mid-stream — turns at the head of the file would be the
    *oldest*, which is the part we already chose to drop on the
    `maxTurns` cap; refusing the read entirely is simpler than
    seeking-from-end.)
  - Per-turn text cap: assistant `text` and `thinking` content
    bigger than **50_000 bytes** is byte-clipped + flagged
    (paired `truncated: true` on the turn). Avoids one huge turn
    (e.g. an agent dumping a 2 MB file) blowing past the wire
    budget.
  - **Read-only**: `query`, no `mutation`. Procedure does not write
    anything to disk — only `readFileSync`.
- Update `app/tasks/[id]/page.tsx` to fetch + render the
  transcript:
  - New `TranscriptSection` component below `ResultSection`.
  - Empty state: "No transcript on disk. Session file may live on
    a different host or has been deleted." when `fileMissing ===
    true`.
  - Banner: "Transcript file is N MB — too large to render. Open
    `<filePath>` directly." when `fileTooLarge === true`.
  - Banner: "Showing the most recent N of M turns." when
    `truncated === true`.
  - Per-turn rendering:
    - `user` text turn → user-coloured card with `text`.
    - `user_tool_result` → compact card with `tool_use_id` +
      collapsed result body.
    - `assistant_text` → markdown-rendered card (uses
      `MARKDOWN_REHYPE_PLUGINS` from T06).
    - `assistant_thinking` → muted card, `<pre>` body, signature
      hidden (only the thinking text shown).
    - `assistant_tool_use` → compact one-line `tool_name(input
      preview)` with the full input JSON inside `<details>`.
    - `system` → muted small card with `text`.
    - `meta` → header with `type`, raw JSON collapsed inside
      `<details>` (Risk #3 fallback).
    - `raw` → `<pre>` with the raw line, dim styling.
  - No `"use client"` — every interaction is a `<details>` /
    plain link. Same pattern as T06.
- Tests:
  - `tests/lib/transcript.test.ts` — pure unit tests for
    `projectSlug` / `transcriptPath` / `parseTranscriptLine` /
    `parseTranscript`.
  - Extend `tests/server/tasks-router.test.ts` with a new
    `describe("tasks.transcript")` block that writes a JSONL
    fixture into a temp dir, points the procedure at it via a
    `CLAUDE_HOME` env, and asserts the wire payload shape.

Out:
- Live streaming the transcript as new turns arrive — that's part
  of T08 (SSE). T07 ships a single-shot read on page load.
- Editing or annotating turns. Read-only invariant.
- A dedicated `/tasks/[id]/transcript` route. We surface the
  transcript inline on the existing detail page — fewer round-
  trips, simpler navigation.
- Pinning a Claude Code minor version in `engines`. v1 §Risks #3
  recommends it but it's a Phase-2 hardening decision.
- Sidechain handling — sub-agent transcripts have
  `isSidechain: true` lines mixed in. We render them as regular
  turns; visually flagging the sidechain belongs to T11 polish.

## Acceptance criteria

1. `projectSlug` returns the path with every `/` replaced by `-`.
   E.g. `/Users/foo/bar/baz` → `-Users-foo-bar-baz`. Empty input
   returns empty string. A path that already starts without `/`
   stays unchanged at the leading position.
2. `transcriptPath` joins to
   `<home>/projects/<slug>/<sessionId>.jsonl`.
3. `parseTranscriptLine` handles every observed top-level `type`
   field:
   - `user` with `message.content: string` → `kind: "user"`,
     `text` is the content string.
   - `user` with `message.content: [{ type: "tool_result", ...
     }]` → `kind: "user_tool_result"` per tool_result element
     (one turn per element).
   - `assistant` with `message.content[]` → emit one turn **per
     content block** (text → `assistant_text`, thinking →
     `assistant_thinking`, tool_use → `assistant_tool_use`).
     Block-level `model` carried from `message.model`.
   - `system` → `kind: "system"`, text from `content` if present.
   - Any other type (`permission-mode`, `queue-operation`,
     `attachment`, `last-prompt`, `task_reminder`, `date_change`,
     `skill_listing`, `mcp_instructions_delta`,
     `deferred_tools_delta`, future unknowns) → `kind: "meta"`
     with `type` preserved + `rawJson`.
   - JSON parse failure → `kind: "raw"` with the original line.
4. `parseTranscript` keeps the **last** `maxTurns` turns when the
   total exceeds the cap, sets `truncated: true`, and reports
   `totalLines` (counted before any cap).
5. `tasks.transcript({ id })`:
   - Returns `null` for unknown id (no throw).
   - LEFT JOIN `agents` to resolve `project_dir` + `session_id`.
   - Computes path via `projectSlug` + `transcriptPath` using
     `process.env.CLAUDE_HOME ?? <homedir>/.claude` as the root.
   - When the path is missing on disk → returns
     `{ ..., fileMissing: true, turns: [], totalLines: 0,
        truncated: false, fileTooLarge: false, fileBytes: 0 }`
     with `filePath` populated for debug.
   - When the file is > 5 MB → returns
     `fileTooLarge: true, turns: [], totalLines: 0,
      truncated: false, fileBytes: <actual>`. (Don't read the
     content — only `statSync` to read size.)
   - Otherwise → reads the file, parses, returns turns with
     per-turn text clipped to 50_000 bytes when applicable.
6. Page `/tasks/[id]`:
   - Adds a Transcript card after the Result card.
   - Renders banners for `fileMissing` / `fileTooLarge` /
     `truncated`.
   - Renders each turn with the per-kind styling described above.
   - Tool-use input renders compact (one-line summary + collapsed
     `<details>` for full JSON).
   - Assistant `text` rendered through the same
     `MARKDOWN_REHYPE_PLUGINS` stack as the result section (XSS
     defence).
   - No `"use client"` directive.
7. Read-only invariant:
   - `tasks.transcript` registered with
     `publicProcedure.query(...)`.
   - The page emits no mutation, no `<form action method="post">`,
     no Server Action.
   - The procedure performs zero filesystem writes — only
     `existsSync` / `statSync` / `readFileSync`.
   - On-disk path strings (`filePath`) ARE surfaced — but only
     for the *transcript file the user already owns on the same
     host*. They're not credentials and they help the user open
     the file in their editor when the dashboard truncates. This
     is a deliberate scope decision; document in the review.

## TDD plan

### Unit (`tests/lib/transcript.test.ts`) — new file

1. `projectSlug("/Users/foo/bar")` → `"-Users-foo-bar"`.
2. `projectSlug("/")` → `"-"`.
3. `projectSlug("")` → `""`.
4. `projectSlug("relative/path")` → `"relative-path"` (no
   leading `-`).
5. `transcriptPath("/home", "-Users-x", "abc")` →
   `"/home/projects/-Users-x/abc.jsonl"`.
6. `parseTranscriptLine` returns `kind: "raw"` for invalid JSON.
7. `parseTranscriptLine` returns `kind: "user"` for a user/string
   content line.
8. `parseTranscriptLine` returns `kind: "user_tool_result"` for a
   user/tool_result content array (one per element).
9. `parseTranscriptLine` returns one
   `kind: "assistant_text"` turn per `text` block in an assistant
   message; preserves `model`.
10. `parseTranscriptLine` returns
    `kind: "assistant_thinking"` per `thinking` block (drops
    signature).
11. `parseTranscriptLine` returns
    `kind: "assistant_tool_use"` per `tool_use` block, capturing
    `name` + `id` + JSON-stringified `input`.
12. `parseTranscriptLine` returns `kind: "meta"` for unknown
    top-level types.
13. `parseTranscript` parses a multi-line content string,
    preserves order, sets `totalLines` and
    `truncated: false` when under cap.
14. `parseTranscript` keeps the last N turns and sets
    `truncated: true` when total exceeds `maxTurns`.
15. `parseTranscriptLine` byte-clips a giant assistant text block
    at the per-turn cap and flags it. (Calls
    `parseTranscriptLine` with an `opts.perTurnByteLimit` option
    to keep the function pure — the procedure layer passes
    50_000.)
16. `parseTranscriptLine` skips empty lines silently (returned
    `null` so the caller filters them out — allows `parseTranscript`
    to handle blank trailing lines).

### Integration (`tests/server/tasks-router.test.ts`) — extend

Add `describe("tasks.transcript")` block with a small
`writeTranscriptFixture(home, slug, sessionId, lines)` helper that
materialises a JSONL file under `<home>/projects/<slug>/`. Override
`process.env.CLAUDE_HOME` to the test temp dir before each test.

1. Returns `null` for unknown task id (no throw).
2. Returns `fileMissing: true` for a known task whose JSONL
   doesn't exist on disk.
3. Reads + parses a 3-line fixture (system → user → assistant
   text), returns 3 turns ordered as written.
4. Sets `fileTooLarge: true` when the file exceeds 5 MB; turns
   array empty; `fileBytes` is the actual size (> 5_000_000).
5. Sets `truncated: true` + keeps last 500 turns when fixture
   has 600 lines.
6. Tool-use turn surfaces `toolName`, `toolUseId`, and stringified
   `input` JSON.
7. Read-only — registered with `.query(...)`, not `.mutation(...)`.

### Component / browser

Skipped at this layer (no jsdom). Playwright in T13 will exercise
the full `/tasks/[id]` flow including the transcript card. Manual
note in the review listing the steps to verify in browser.

## Notes / open questions

- **Per-turn byte cap (50_000).** Smaller than the markdown cap
  (500_000) on purpose: the transcript can have 100s of turns and
  each turn is a separate render; one giant turn shouldn't bloat
  the page. Same byte-clipping helper (`Buffer.subarray + toString
  ("utf8")`) reused.
- **Why 500 turns?** A typical Claude Code session has 30–200
  turns. 500 covers >90% of cases without truncation while keeping
  the wire payload bounded (~25 MB worst case at 50 KB per turn).
- **Why parse on the server?** Per ARCH §11 perf budget — server
  components prefer pre-shaped data so the client doesn't reparse
  ≈ 1 MB JSON. Server parses once, ships ~ shape-checked turns.
- **Sidechain mixing.** Lines with `isSidechain: true` are emitted
  by sub-agent runs (Task tool). For Phase 1 we render them
  inline, untagged. T11 may add a visual chip.
- **No `result_file` reading.** v1 §4.2 says
  `tasks.transcript({ id }) // (read result_file)`. Reading
  `result_file` (an absolute path on the daemon's disk) is a
  read-only invariant violation: the user could craft a task with
  `result_file = /etc/passwd` and have the dashboard render it.
  The Claude Code JSONL path is constrained by the schema
  (always `~/.claude/projects/<slug>/<session_id>.jsonl`) — the
  user can't pivot it. Stick with the constrained path; document
  the divergence here.
- **`CLAUDE_HOME` env var.** If unset, default to
  `<homedir>/.claude`. Tests override it to the temp dir; in
  production it's the user's home. Mirrors the
  `CLAUDE_BRIDGE_HOME` convention from `discovery.ts`.
- **Tool-use `input` rendering.** A summary one-liner via
  `JSON.stringify(input).slice(0, 200)` keeps the visible card
  short; the full JSON sits inside `<details>` for power users.
- **Markdown XSS in assistant text.** Same threat as `result_summary`
  (T06): assistant might output literal `<script>`. Reuses
  `MARKDOWN_REHYPE_PLUGINS` (rehype-sanitize). No new sanitization
  schema — the rehype-sanitize default GitHub allowlist matches
  v1 ARCH §10.
- **Truncation semantics.** When the file has 600 turns, we keep
  the most-recent 500 and flag `truncated: true`. The dropped
  turns are at the *start* of the file (oldest). Acceptance is
  that the user sees the live tail — what matters is the *current*
  state of the agent, not the first request.
- **Acceptance "tool_use block render compact".** "Compact" =
  one line `tool_name(input-preview)` + collapsible details.
  Verified via the per-kind rendering in the page.
- **Acceptance "thấy stream live của Claude Code".** *Live* is
  T08 (SSE). T07 ships single-shot read on page load — the user
  hits refresh to see new turns. Document in the review;
  acceptance bullet for T07 is "transcript renders correctly",
  the `live stream` part is expressly T08.
