# P1-T08 — SSE endpoint `/api/stream/tasks` — Self-Review

> Spec: `T08-sse-tasks.md`. Iter 9/17.

## Files changed / added

**New:**
- `src/lib/sse.ts` — pure SSE wire-format helpers + task-snapshot
  diff (`formatSseEvent`, `formatSseComment`,
  `SSE_HEARTBEAT_COMMENT`, `diffTaskSnapshots`,
  `TaskSnapshot`/`TaskUpdateEvent` types).
- `src/server/sse-tasks.ts` — `createTaskStreamResponse({ signal,
  pollMs, heartbeatMs, readSnapshot })` — wraps the diff into a
  `Response<ReadableStream>` with init/update events + heartbeat.
- `app/api/stream/tasks/route.ts` — Next.js GET-only route
  handler. Reads top-200 most-recent tasks each tick, delegates
  to `createTaskStreamResponse`. `dynamic = "force-dynamic"`,
  `runtime = "nodejs"`.
- `tests/lib/sse.test.ts` — 13 unit tests, 31 expects.
- `tests/server/sse-tasks.test.ts` — 6 integration tests (fake
  `readSnapshot`, short `pollMs`/`heartbeatMs`), 14 expects.
- `tests/app/stream-tasks-route.test.ts` — 2 smoke tests with a
  temp-DB seeded `BRIDGE_DB`, 11 expects.
- `docs/tasks/phase-1/T08-sse-tasks.md` — task spec.
- `docs/tasks/phase-1/T08-review.md` — this file.

**Modified:**
- `docs/tasks/phase-1/INDEX.md` — checkbox + status line bump.

No production deps changed; no schema changes; no DB-write code
introduced.

## Self-review checklist

- [x] **Tests cover happy + 1 edge case** — happy path (init +
  update), edge cases: byte-identical snapshot (no events), task
  drops out of LIMIT-200 window (forgets prev), abort closes
  stream, multi-line string event splits to one `data:` line per
  chunk.
- [x] **Not over-engineered** — single-topic endpoint (no
  multiplex), polling-only (no BridgeBus), no per-process
  subscriber bookkeeping. Each deliberate omission documented in
  the task spec under "Out".
- [x] **ARCHITECTURE v2 picks honoured** — Next.js App Router
  (route handler at `app/api/stream/tasks/route.ts`), bun:sqlite
  via existing Drizzle `getDb()`, plain `Response` with
  `ReadableStream` (no extra deps). v1 ARCH §5 SSE choice
  preserved; tRPC subscription path explicitly deferred to Phase
  2 (documented in spec).
- [x] **No secret leak** — payload only carries
  `id / status / costUsd / completedAt`; same fields the global
  Tasks page already exposes. No file paths, no agent metadata,
  no JWT data.
- [x] **Read-only: NO mutation/dispatch call** —
  - `app/api/stream/tasks/route.ts` exports only `GET`. Test
    `route module exports a GET handler and no mutation handlers`
    asserts that POST/PUT/PATCH/DELETE are undefined.
  - The handler only calls `getDb().select(...).all()`; grep
    confirms no `.insert()`, `.update()`, `.delete()` in the
    new files (`grep -r "\.insert\|\.update\|\.delete"
    src/server/sse-tasks.ts app/api/stream/tasks/route.ts
    src/lib/sse.ts` → empty).
  - The pure helper module has zero IO imports; the streaming
    helper module never writes to disk; the route handler never
    writes to disk.

## Acceptance bullets vs spec

1. ✅ `formatSseEvent("update", { id: 1, status: "done" })` →
   `"event: update\ndata: {\"id\":1,\"status\":\"done\"}\n\n"`
   (test #1 in `tests/lib/sse.test.ts`).
2. ✅ Multi-line string payload splits to one `data:` line per
   `\n` chunk (test #3).
3. ✅ `formatSseComment("hi")` → `": hi\n\n"` (test #4).
4. ✅ `diffTaskSnapshots(empty, [a, b])` emits 2 events, 2-entry
   next snapshot (test #7 in the diff describe).
5. ✅ Byte-identical snapshot → 0 events (test #8).
6. ✅ Single-field change emits one update (status / cost /
   completedAt — three separate tests: #9, #10, #11).
7. ✅ Tasks aging out of curr window are forgotten in next
   snapshot (test #12).
8. ✅ `createTaskStreamResponse` returns `text/event-stream` +
   `no-cache` + `X-Accel-Buffering: no`; emits init, then
   updates, then heartbeat; abort closes (6 tests in
   `tests/server/sse-tasks.test.ts`).
9. ✅ Route handler returns `text/event-stream` and the first
   frame's `data:` line carries every seeded task id (test
   `returns a Response with text/event-stream and emits init for
   seeded tasks` in `tests/app/stream-tasks-route.test.ts`).
10. ✅ Read-only invariant — covered by the route-handler test
    that asserts no POST/PUT/PATCH/DELETE exports, plus manual
    inspection of the three new source files (no
    `insert`/`update`/`delete` calls anywhere).

## Issues found / decisions

- **Live UI consumer not wired in T08.** The endpoint emits
  correct SSE; no client component subscribes yet. The page
  stack is server-rendered, so wiring an `EventSource` requires a
  `"use client"` shell. Decision: **defer to T11** (empty/error
  states + polish) or a later phase task. T08's acceptance is
  "endpoint emits events" — the consumer is a separate slice.
  Documented in spec / Notes.
- **DB read errors** wrap into an `error` SSE event but the
  stream stays open so a transient lock doesn't tear down every
  client. If a permanent error happens, the next poll re-emits
  the same `error`; a future task could add a retry/backoff or
  a circuit breaker. Decision: **acceptable for Phase 1** — log
  pressure is low, daemon writes are short.
- **No per-process subscriber count.** v1 §5 mentions "polling
  chỉ chạy khi có ít nhất 1 SSE subscriber active" as a perf
  hedge. With one user and read-only DB queries, each connection
  spawning its own 1s poll is well within budget. Decision:
  **defer to Phase 2** (multiplex consolidation will naturally
  add subscriber tracking).
- **No backpressure handling.** If a client connects but never
  reads, the `enqueue` calls accumulate in the
  `ReadableStream` queue. Browsers with an active `EventSource`
  will keep draining; an idle abandoned tab will eventually
  reach the queue's high-water mark and back off naturally.
  Decision: **acceptable** — the worst case is a ~few-MB queue
  before the OS drops the TCP connection.
- **Wire payload field names.** Used camelCase
  (`costUsd`, `completedAt`) to match the existing tRPC DTOs
  (`AgentTaskRow`, `GlobalTaskRow`). The future client merge
  layer can reuse the field names verbatim — no rename layer
  needed.

## Test summary

```
$ bun test
 159 pass
   0 fail
 475 expect() calls
Ran 159 tests across 15 files. [470 ms]
```

Up from 138 → 159 (+21 new): 13 in `tests/lib/sse.test.ts`, 6
in `tests/server/sse-tasks.test.ts`, 2 in
`tests/app/stream-tasks-route.test.ts`.

Typecheck (`bun run typecheck`) clean.

## Manual browser verification checklist (for the loop's
PHASE-BROWSER-TEST step)

Phase-1 sign-off browser test should include:

- [ ] `curl -N http://127.0.0.1:7878/api/stream/tasks` (with the
      session cookie via `--cookie`) — see at least one
      `event: init` frame within 2s.
- [ ] `bridge dispatch alpha "hello"` from another terminal —
      the curl stream should print an `event: update` with
      `"status":"queued"` (then `"running"`, then `"done"`)
      within ~2s of each daemon write.
- [ ] After ~15s of idle, the stream should print `: heartbeat`
      to keep the connection open.

Browser harness (T13 / Playwright) will exercise this for real.
T08 itself doesn't touch the page; nothing renders differently
yet.
