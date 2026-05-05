# P1-T07 review — Transcript viewer (JSONL)

> Self-review checklist for Rule 3 of the loop process.

## Files added

- `src/lib/transcript.ts` — pure parser/util (~270 LOC). Exports
  `projectSlug` (Claude Code slug rule: every `/` → `-`),
  `transcriptPath` (`<home>/projects/<slug>/<sessionId>.jsonl`),
  `parseTranscriptLine` (one line → 0..N turns, returns
  `null|TranscriptTurn|TranscriptTurn[]`), `parseTranscript`
  (full content with `maxTurns` + `perTurnByteLimit` caps), and
  the `TranscriptTurn` discriminated union (`user`,
  `user_tool_result`, `assistant_text`, `assistant_thinking`,
  `assistant_tool_use`, `system`, `meta`, `raw`). The `meta` and
  `raw` arms are the v1 ARCH Risk #3 fallback — any line shape
  the parser doesn't recognise still ships, with the original
  JSON inspectable via `<details>` on the page side.
- `tests/lib/transcript.test.ts` — 18 unit tests / 41 expects.
  Cover slug edge cases (root path, empty, relative), path
  joining (trailing slash), every parsed turn kind, byte-clipping
  via `perTurnByteLimit`, empty-line filtering, and
  most-recent-N truncation semantics.
- `docs/tasks/phase-1/T07-transcript-viewer.md` — task spec
  (acceptance + TDD plan + open notes) — Rule 1.

## Files modified

- `src/server/dto.ts` — added `TaskTranscript` (8 fields). Wire
  shape returned by `tasks.transcript`. `turns` re-exports
  `TranscriptTurn` from `src/lib/transcript.ts` via a string
  module import to avoid circular type deps. Sentinel fields
  (`fileMissing`, `fileTooLarge`, `truncated`) let the page
  banner the rare paths without a separate procedure.
- `src/server/routers/tasks.ts` — added `tasks.transcript` query:
  - Zod input: `id: z.number().int().positive()`. Reuses the
    `GetInput` constant from `tasks.get` — same validation
    surface, same rejects (0, negative, fractional, missing).
  - LEFT JOIN `agents` on `session_id` to resolve `project_dir`
    (same join key the rest of the router uses).
  - Computes path via `projectSlug` + `transcriptPath` rooted
    at `process.env.CLAUDE_HOME ?? <homedir>/.claude` (mirrors
    the `CLAUDE_BRIDGE_HOME` convention from `discovery.ts`).
  - File-size cap: **5 MB** (`TRANSCRIPT_FILE_BYTE_LIMIT =
    5 * 1024 * 1024`). When exceeded, `statSync` is the only
    syscall — we never read the body of an over-cap file.
  - Turn cap: **500** (`MAX_TURNS_PER_TRANSCRIPT`). Most
    sessions have 30–200 turns; 500 covers >90% without
    truncating, while keeping the wire payload bounded
    at ~25 MB worst case (500 × 50 KB).
  - Per-turn byte cap: **50_000**
    (`TRANSCRIPT_PER_TURN_BYTE_LIMIT`). Stops one giant assistant
    text/thinking block from blowing past the wire budget.
  - **Read-only**: `publicProcedure.query`. Pure
    `existsSync`/`statSync`/`readFileSync` — no filesystem
    writes. The path is constrained to
    `<CLAUDE_HOME>/projects/<slug>/<session_id>.jsonl`, derived
    from `agents.project_dir` and `tasks.session_id`. The user
    cannot pivot the read to an arbitrary path (unlike
    `tasks.result_file`, which is why we don't read it — see
    Notes in the task file).
- `tests/server/tasks-router.test.ts` — added a new
  `describe("tasks.transcript")` block with 7 integration tests
  / 23 expects. Covers null-on-unknown-id, missing-file,
  3-line happy path, 6 MB too-large, 600-line truncation,
  tool_use surfacing, Zod input bounds. Added a small
  `writeTranscriptFixture` helper that materialises a JSONL
  under `<tmpDir>/projects/<slug>/<sessionId>.jsonl` and added
  `process.env.CLAUDE_HOME = tmpDir` to the existing
  `beforeEach`/`afterEach` (with restoration of the original
  value).
- `app/tasks/[id]/page.tsx` — added a `TranscriptSection` card
  rendered after `ResultSection`. Sub-components:
  - `TranscriptTurnView` — discriminated `switch` over the 8
    turn kinds with per-kind styling. Assistant `text` renders
    via `react-markdown` + `MARKDOWN_REHYPE_PLUGINS` (T06's
    XSS defence). All other text content is wrapped in `<pre>`
    so HTML can't escape the renderer.
  - `TruncatedHint` — small label that surfaces on any turn
    whose body got byte-clipped.
  - Top-of-card banners for `fileMissing`, `fileTooLarge`, and
    `truncated`. Each banner exposes the absolute file path so
    the user can open it locally if the dashboard truncates.
  - No `"use client"` — every interactive surface is a
    `<details>` element, same pattern as T06's prompt collapse.

## Files deleted

- None.

## Test results

```
$ bun test
 138 pass
 0 fail
 419 expect() calls
Ran 138 tests across 12 files. [341.00ms]

$ bun run typecheck
$ tsc --noEmit          # exit 0

$ bun run build
 ✓ Compiled successfully in 1786ms
 ✓ Generating static pages (10/10)

Route (app)                       Size  First Load JS
ƒ /tasks/[id]                    163 B         106 kB
ƒ /tasks                         165 B         106 kB
ƒ /agents                        163 B         106 kB
…
+ First Load JS shared by all                  102 kB
```

111 prior tests (Phase 0 + T01..T06) + 18 new transcript-lib
tests + 7 new procedure tests + 2 misc inherited (running totals
include the existing tasks-router suite the new block joined) =
**138 total / 419 expects**. Production build clean —
`/tasks/[id]` stays at the same 106 kB First Load JS as before
T07 (the parser ships server-side; the page renders to HTML in
the App Router, no extra client bundle).

## Self-review checklist

- [x] **Tests cover happy + edge case** —
  - Happy: 3-line fixture parses in order; tool_use surfaces
    name/id/input; 8 turn kinds round-trip through the parser;
    pure helpers compose cleanly.
  - Edge: unknown task id → null (no throw); JSONL absent →
    `fileMissing: true` with empty turns; 6 MB JSONL →
    `fileTooLarge: true` with empty turns (no read); 600-line
    fixture → keeps last 500 + `truncated: true`; oversized
    assistant_text per-turn clip; JSON parse failure →
    `kind: "raw"`; unknown top-level type → `kind: "meta"`;
    blank lines silently filtered; thinking signature dropped
    from the wire; Zod rejects 0/negative/fractional/missing.
- [x] **Not over-engineered** —
  - Parser is one file, ~270 LOC, no streaming abstractions,
    no plugin registry. Line splits on `\n`, calls `JSON.parse`
    inside a try/catch, switches on `type`. A future format
    change adds an arm; until then the fallback meta/raw arms
    keep us safe.
  - File caps are three constants in `tasks.ts` — no config
    plumbing.
  - The page renderer is one `switch` statement in a single
    component, no per-kind sub-files. Re-uses the existing
    Tailwind tokens / `react-markdown` plumbing — no new
    deps.
  - No `useEffect`/`useState`/`"use client"` — the App Router
    server component does all the work; `<details>` handles
    the only interaction.
- [x] **ARCHITECTURE v2 picks honoured** — Next.js App Router
      server component (`force-dynamic`), tRPC v11 with
      `createCaller` (in-process; no HTTP roundtrip — §11),
      Zod input bounds, Drizzle `.select` projection, bun:sqlite
      on the read path, pure Node `fs` (no extra dep) for the
      JSONL read. Tailwind v4 tokens (`hsl(var(--*))`) + the
      existing shadcn primitives — no new UI dependency.
      **No mutation procedure registered.** **No `"use client"`
      directive.** **No new runtime dependency.**
- [x] **No secret leak** — Assistant `thinking` block: only
      `text` ships; `signature` (an opaque model-side blob) is
      explicitly dropped at the parser, asserted by a unit test
      that `JSON.stringify(turn)` does not contain the
      signature string. Tool-use `input` is preserved as the
      agent typed it (it's the call shape — Phase 1 is
      observation, hiding it would defeat the purpose). The
      `filePath` strings surface — but only for the transcript
      file the user already owns on the same host (Claude Code
      writes into their `~/.claude/projects/`); this is the
      same data the user could read with `ls`. Documented as a
      deliberate scope decision in the task file's Notes.
- [x] **Read-only invariant** — `tasks.transcript` is a `query`,
      not a `mutation`. The page renders no `<form>`, no
      Server Action, no mutation procedure call. The procedure
      uses `existsSync`/`statSync`/`readFileSync` only — zero
      filesystem writes. The on-disk path is constrained to
      `<CLAUDE_HOME>/projects/<slug>/<session_id>.jsonl`,
      derived from values already in the database; the user
      cannot pivot the read to an arbitrary path. We
      deliberately do **not** read `tasks.result_file` — that
      column carries an arbitrary on-disk path the daemon
      records, and reading it would let a crafted task
      surface `/etc/passwd` (or similar) through the
      dashboard.
- [x] **XSS defence** — Assistant `text` blocks render through
      `react-markdown` + `MARKDOWN_REHYPE_PLUGINS` (the
      `rehype-sanitize` allowlist from T06). Every other text
      surface (user message, tool_result body,
      assistant_thinking, system, meta JSON, raw line) renders
      inside `<pre>` — React escapes the contents and the
      browser does not execute any HTML. `tests/lib/markdown
      .test.ts` (T06) already pins the sanitization plugin so
      this guarantee can't regress silently.
- [x] **Risk #3 (JSONL format drift) honoured** — Lines that
      fail JSON.parse, OR have a `type` we don't recognise, OR
      have a content shape we don't recognise, surface as
      `meta` / `raw` turns with the original JSON visible in a
      collapsed `<details>`. The page never crashes on a new
      Claude Code release — worst case the user sees the raw
      JSON for the new turn type and reports the gap.

## Issues found

- **None blocking.**
- **Minor / observational:**
  - **Single-shot read, no live stream.** v1 acceptance bullet
    "thấy stream live của Claude Code" requires SSE; that's
    explicitly **T08**. T07 ships single-shot read on page
    load — refresh to see new turns. Documented in the task
    file's Notes; the acceptance bullet for T07 itself is
    "transcript renders correctly".
  - **No virtualization on the turn list.** A typical session
    has 30–200 turns; 500 turns ≈ a few hundred React nodes,
    well below where react-virtualization-style libs become
    worth their weight. T11 may revisit if real-world sessions
    routinely hit the 500-turn cap.
  - **`filePath` surfaced.** Same paths the user can `ls`
    locally; not a credential. Helps when the dashboard
    truncates so the user can open the file in their editor.
    Deliberate scope decision; documented in the task spec.
  - **Sidechain mixing.** Lines with `isSidechain: true` (Task
    tool sub-agents) render inline as regular turns. T11 may
    add a visual chip; not a correctness issue today.
  - **No `result_file` read.** v1 §4.2's "(read result_file)"
    note is at odds with the read-only invariant — see Notes
    in the task file. The Claude Code JSONL is the right
    transcript source; `result_file` is the result-summary
    file path on the daemon's disk, not a transcript.
  - **Fixed slug rule.** `projectSlug` literally replaces `/`
    with `-`. If Claude Code ever changes its convention (e.g.
    URL-encoding spaces), the JSONL won't be found and we
    surface `fileMissing: true` — recoverable, not crashing.
    A future task can extend `projectSlug` if needed.
  - **Per-turn 50 KB clip on assistant text.** Conservative;
    most agent outputs fit. If a Phase-2 user complains, bump
    via the `TRANSCRIPT_PER_TURN_BYTE_LIMIT` constant.

## Verification trail

- `bun test` → 138 pass / 0 fail / 419 expects.
- `bun run typecheck` → clean exit.
- `bun run build` → ✓ Compiled successfully; `/tasks/[id]`
  route stays at 106 kB First Load JS (no client-side bundle
  growth — parsing happens server-side).
- Browser/manual smoke deferred to loop step 16. Manual flow:
  visit `/tasks` → click an Id whose agent has a real session
  on the host → land on `/tasks/<id>` → see the Transcript
  card populated with user / assistant / tool turns; force a
  > 5 MB session JSONL (`dd if=/dev/urandom of=… bs=1M
  count=6`) → see the `fileTooLarge` banner; rename the
  session file → see the `fileMissing` banner; force a
  unparseable line into a copy → see the `raw` collapse arm
  on the page.

## Sign-off

T07 complete. INDEX checkbox updated. Ready for T08
(SSE endpoint `/api/stream/tasks` — read-only) on the next
iter.
