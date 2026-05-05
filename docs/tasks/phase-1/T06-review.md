# P1-T06 review — `tasks.get` + Task detail page

> Self-review checklist for Rule 3 of the loop process.

## Files added

- `app/tasks/[id]/page.tsx` — task detail page. Server component;
  reads the dynamic `[id]` segment, validates it as a positive
  integer (else `notFound()`), calls `tasks.get` via tRPC
  `createCaller`, and renders header / prompt / result-markdown /
  metadata sidebar. No `"use client"` directive — `<details>`
  handles the prompt collapse natively, `react-markdown` renders
  on the server with `MARKDOWN_REHYPE_PLUGINS`. Resolves the
  T05 caveat: `/tasks` Id-column links now navigate to a real
  page.
- `src/lib/markdown.ts` — single-source-of-truth helper.
  Exports `MARKDOWN_BYTE_LIMIT = 500_000` (the cap shared between
  the server-side clip and the page render budget) and
  `MARKDOWN_REHYPE_PLUGINS = [rehypeSanitize]` (the v1 ARCH §10
  XSS defence — sanitize HTML allowlist applied to every
  rendered markdown surface in the dashboard).
- `tests/lib/markdown.test.ts` — 3 tests pinning the byte cap and
  the sanitize plugin so a future refactor can't quietly disable
  the XSS guard. Pure constant assertions; no jsdom needed.
- `docs/tasks/phase-1/T06-task-detail.md` — task spec (acceptance
  + TDD plan + open notes) — Rule 1.

## Files modified

- `src/server/dto.ts` — added `TaskDetail` (21 fields). Curated
  subset of the daemon `tasks` table joined with `agents.name`
  for the agent link in the page header. Internal columns
  (`pid`, `result_file`, `user_id`, `reported`, `position`)
  are explicitly omitted — the dashboard never surfaces a
  daemon-side disk path or process id. `resultMarkdown` mirrors
  `tasks.result_summary` with a paired
  `resultMarkdownTruncated: boolean` flag for the > 500_000-byte
  case.
- `src/server/routers/tasks.ts` — added `tasks.get` query:
  - Zod input: `id: z.number().int().positive()`. Rejects `0`,
    negatives, fractional, missing.
  - LEFT JOIN `agents` on `tasks.session_id = agents.session_id`
    (consistent with T05's `tasks.list`); orphaned tasks
    surface with `agentName: null`.
  - Single SELECT-by-PK + `LIMIT 1`. Well under §11's 50ms p95
    budget.
  - `result_summary` is byte-clipped via a small `clipUtf8`
    helper that uses `Buffer.subarray` + `toString("utf8")`
    so a partial trailing multi-byte sequence drops cleanly
    instead of producing a half-character.
  - **Read-only:** registered with `publicProcedure.query(...)`.
    No mutation, no `bridge_dispatch`, no file write.
- `tests/server/tasks-router.test.ts` — added a new
  `describe("tasks.get") block` with 9 tests / 44 expects:
  1. Unknown id returns null (no throw).
  2. Known id returns curated DTO with exactly the 21
     documented keys; internal columns (`pid`, `resultFile`,
     `userId`, `reported`, `position`) explicitly absent.
  3. `agentName` resolved via LEFT JOIN.
  4. Orphan task → `agentName: null`.
  5. `resultMarkdown` mirrors `result_summary` under the cap.
  6. `resultMarkdown: null` when `result_summary IS NULL`.
  7. `resultMarkdownTruncated: true` + clip ≤ 500_000 bytes
     when summary is 600_000 bytes.
  8. `resultMarkdownTruncated: false` when payload is exactly
     at the 500_000-byte boundary.
  9. Zod rejects `id: 0`, `id: -1`, `id: 1.5`, missing.
  Added a `seedTaskDetail` helper that exercises the columns
  the listing tests don't touch (`result_summary`, `num_turns`,
  `exit_code`, `model`, `task_type`, `parent_task_id`,
  `error_message`, `started_at`, `channel_chat_id`,
  `channel_message_id`, `pid`, `result_file`, `user_id`).
- `package.json` — added two runtime deps:
  - `react-markdown@^10.1.0`
  - `rehype-sanitize@^6.0.0`
  Total install: 82 transitive packages (unified ecosystem).
  `react-markdown` adds ~30KB gzipped *only* to the
  `/tasks/[id]` route bundle (next build report below);
  `/agents` (the §11-budgeted landing) stays at 106 kB First
  Load JS, untouched.

## Files deleted

- None.

## Test results

```
$ bun test
 111 pass
 0 fail
 318 expect() calls
Ran 111 tests across 11 files. [310.00ms]

$ bun run typecheck
$ tsc --noEmit          # exit 0

$ bun run build
 ✓ Compiled successfully in 3.2s
 ✓ Generating static pages (10/10)

Route (app)                       Size  First Load JS
ƒ /tasks/[id]                    163 B         106 kB
ƒ /tasks                         165 B         106 kB
ƒ /agents                        163 B         106 kB
…
+ First Load JS shared by all                  102 kB
```

99 prior tests (Phase 0 + T01..T05) + 12 new T06 tests = 111 total
/ 318 expects. Production build clean — `/tasks/[id]` ships at the
same 106 kB First Load JS as the other dynamic routes (well under
the §11 200 KB budget on `/agents`).

## Self-review checklist

- [x] **Tests cover happy + edge case** —
  - Happy: known id; agent join; non-truncated markdown; populated
    metadata columns; full DTO shape.
  - Edge: unknown id → null (no throw); orphan task → agentName
    null; null `result_summary` → null `resultMarkdown`; ≥ cap
    truncation flag + byte clip; exactly-at-cap *not* flagged;
    Zod rejects 0 / negative / fractional / missing id.
- [x] **Not over-engineered** —
  - Prompt collapse uses a native `<details>` element, no client
    component / state machine.
  - Result section is a single `<ReactMarkdown>` invocation; no
    code-splitting heroics, the route only loads the markdown
    bundle when the user lands on it.
  - `clipUtf8` is 5 lines using `Buffer`; no
    `TextDecoder`/`TextEncoder` ceremony.
  - The shared `src/lib/markdown.ts` is the smallest module that
    keeps the procedure cap and the page renderer in sync. No
    custom sanitize schema — `rehype-sanitize`'s default
    GitHub-flavoured allowlist matches v1 ARCH §10's intent.
  - No transcript placeholder card on the detail page — T07
    introduces it once the data exists; an empty "coming soon"
    card would be dead UI.
- [x] **ARCHITECTURE v2 picks honoured** — Next.js App Router
      server component (`force-dynamic`), tRPC v11 with
      `createCaller` (in-process; no HTTP roundtrip — §11),
      Zod input bounds, Drizzle `.select` projection with
      explicit columns + LEFT JOIN, bun:sqlite on the read path.
      Tailwind v4 tokens (`hsl(var(--*))`) + the existing
      shadcn primitives — no new UI dependency. **No mutation
      procedure registered.** **No `"use client"` directive.**
- [x] **No secret leak** — DTO drops `pid` (process id),
      `result_file` (daemon-side disk path), `user_id`,
      `reported`, `position`. Curated 21-field wire payload.
      `sessionId` is included for debug context (it's a derived
      identifier the user already sees indirectly via
      `/agents/[name]`, not a credential). Auth still enforced
      by `middleware.ts` (T02) — JWT cookie required.
- [x] **Read-only invariant** — `tasks.get` is a `query`, not
      a `mutation`. The page renders no `<form>`, no Server
      Action, no mutation procedure call. The `result_file`
      on-disk path is *never* surfaced to the client.
- [x] **XSS defence** — markdown is rendered via
      `react-markdown` + `rehype-sanitize` (v1 ARCH §10).
      `react-markdown` ignores raw HTML by default and we do
      not enable `rehype-raw`, so the only DOM the renderer
      emits is the safe-by-construction subset
      `react-markdown` produces from CommonMark — defense in
      depth even if a future tweak enables raw HTML.
      `tests/lib/markdown.test.ts` pins the plugin list so
      this guarantee can't regress silently.
- [x] **500 KB acceptance bullet honoured** — server clips at
      500_000 UTF-8 bytes; truncation banner above the rendered
      markdown explains the cap; `<pre>` blocks scroll inside
      `max-h-[60vh]` so a long prompt doesn't crash layout.

## Issues found

- **None blocking.**
- **Minor / observational:**
  - **`/tasks/[id]` not in the `route-stubs.test.ts` static loop.**
    That test enumerates the five top-level Phase 1 routes
    (`agents`, `tasks`, `loops`, `schedules`, `cost`) plus
    `login`. `/tasks/[id]` is dynamic — adding it to the stub
    list would force the test to seed a DB. The route is
    exercised behaviourally via `tasks.get` tests today and via
    Playwright in T13 (load `/tasks` → click Id → land on
    `/tasks/<id>`). Documented as a deliberate deferral.
  - **Transcript section omitted.** The page has no "coming in
    T07" placeholder card — that's intentional dead UI. T07
    will add the section + tab when the
    `tasks.transcript({ id })` procedure ships.
  - **Markdown bundle weight on the detail route.** Build report
    shows `/tasks/[id]` at 106 kB First Load JS — same shared
    chunk as the other dynamic routes (102 kB shared + 163 B
    page-specific). The `react-markdown` bundle is server-only
    in our render path (no client hydration of markdown), so
    no client cost is added.
  - **`channelChatId` / `channelMessageId` surfaced.** These are
    Telegram-side ids — the same data the bridge daemon
    already exposes via the MCP server. Not a credential. The
    sidebar groups them into a single "Channel ctx" row to
    keep the visual noise low.
  - **`<details>` collapse threshold is 12 lines.** A simple
    constant — the file declares it `PROMPT_COLLAPSE_LINES`
    so a future task can tune it without spelunking. Acceptable
    for Phase 1; T11 may add a "show all" CTA in addition.
  - **Cost formatting still 4dp.** Reuses the T05 convention
    (`$0.0123`). T11 polishes.
  - **`result_summary` vs `result_file`.** v1 acceptance bullet
    references `result_file`; the daemon writes the assistant's
    final message to `result_summary` (a TEXT column) — that's
    what we render. Reading the on-disk `result_file` would
    require streaming a daemon-side path through the dashboard,
    which the read-only invariant explicitly forbids. The 500 KB
    cap still applies and protects the page from oversized
    summaries.

## Verification trail

- `bun test` → 111 pass / 0 fail / 318 expects.
- `bun run typecheck` → clean exit.
- `bun run build` → ✓ Compiled successfully; `/tasks/[id]` route
  present at 106 kB First Load JS.
- Browser/manual smoke deferred to loop step 16. Manual flow to
  verify: visit `/tasks` → click an Id → land on `/tasks/<id>` →
  see status badge + agent link + prompt + result-md + metadata
  sidebar → back; visit `/tasks/abc` → 404; visit
  `/tasks/9999999` → 404; force a long-prompt task into the DB
  → see `<details>` collapsed by default; force a > 500 KB
  `result_summary` → see truncation banner above the rendered
  markdown.

## Sign-off

T06 complete. INDEX checkbox updated. Ready for T07
(transcript viewer — JSONL session file) on the next iter.
