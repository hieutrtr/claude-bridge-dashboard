# P1-T08 — SSE endpoint `/api/stream/tasks`

> Phase 1 / Iter 9 of the loop. Adds a server-sent-events endpoint that
> the (future) client can subscribe to via `EventSource` to see task
> status changes near-real-time. Read-only — emits status / cost /
> completed_at deltas the daemon writes; never mutates.

## Source plan reference

- v1 IMPLEMENTATION-PLAN.md §Phase 1, item **P1-T8**:
  - "**SSE endpoint `/api/stream/tasks`** · Server-Sent Events emit
    task status changes, dùng SQLite `update_hook` hoặc poll 1s."
  - "Acceptance: dispatch từ Telegram → dashboard cập nhật badge < 2s
    không reload."
  - "Deps: P1-T5. Risk: trung — nhiều tab mở cùng lúc → connection
    pooling."
- v2 ARCHITECTURE.md §0 — v1 sections still apply.
- v1 ARCHITECTURE.md sections to read **before coding**:
  - **§5 Live Updates** — picks SSE over WebSocket / polling. Two
    server-side mechanisms: (1) BridgeBus `EventEmitter` fired on
    in-process mutations; (2) **1s polling fallback** for mutations
    coming from outside the Next.js process (CLI dispatch, daemon
    writes). Polling only runs when ≥ 1 SSE subscriber is active.
    "Dồn tất cả live update qua 1 SSE stream channel-multiplexed
    (`/api/stream?topics=tasks,loops,agents`)" — but Phase 1 ships a
    **single-topic** stream first; multiplex is Phase 2 polish.
  - **§10 Security** — endpoint sits behind the same env-password
    auth middleware as everything else (already wired in T02 — the
    middleware matcher catches `/api/*`).
  - **§11 perf budgets** — DB query p95 < 50ms. Poll selects the
    most-recent 200 tasks (`select id, status, cost_usd,
    completed_at from tasks order by id desc limit 200`) — under
    the budget on a 10k-row table because the index on `id` makes
    this an O(limit) range scan.

## Scope

**In:**

- New helper module `src/lib/sse.ts` — pure / IO-free:
  - `formatSseEvent(event: string, data: unknown): string` — emits
    `event: <name>\ndata: <json>\n\n`. Handles multi-line strings by
    splitting on `\n` and prefixing each line with `data: ` (per
    SSE spec); non-string `data` is `JSON.stringify`'d and treated
    as a single line.
  - `formatSseComment(text: string): string` — emits `: <text>\n\n`.
    Used for the keepalive heartbeat.
  - `SSE_HEARTBEAT_COMMENT` constant — pre-formatted ":
    heartbeat\n\n" for the periodic keepalive frame.
  - `diffTaskSnapshots(prev, curr)` — given a `Map<id, TaskSnapshot>`
    of the previous tick and an array of the current tick's rows,
    returns:
    - `events: TaskUpdateEvent[]` — one event per **new** task and
      one per task whose `status` / `costUsd` / `completedAt`
      changed.
    - `nextSnapshot: Map<id, TaskSnapshot>` — the merged map
      keyed by id (only ids present in `curr` carry forward; if a
      task drops out of the LIMIT-200 window we forget it — the
      SSE stream is a tail-of-recent feed, not a full audit).
- New helper `src/server/sse-tasks.ts` — wires the diff into a
  `Response` with a `ReadableStream`:
  - `createTaskStreamResponse({ signal, pollMs, heartbeatMs,
    readSnapshot, now })`:
    - Emits an `init` event on connect with the full current
      snapshot (up to 200 most-recent tasks). Lets a fresh
      EventSource render the latest state without an extra round
      trip.
    - Schedules `tick()` every `pollMs` (default 1000). Reads the
      snapshot, diffs against `prev`, emits one `update` event per
      changed/new task.
    - Schedules a heartbeat comment every `heartbeatMs` (default
      15_000) so proxies don't time out the idle connection.
    - On `signal.aborted` → clears intervals, closes the stream.
    - Returns a `Response` with `Content-Type: text/event-stream`,
      `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering:
      no`.
  - Pulled out of the route handler so it can be unit-tested with a
    fake `readSnapshot` (no DB required).
- New route handler `app/api/stream/tasks/route.ts`:
  - Single GET handler. Imports `createTaskStreamResponse` and
    passes a `readSnapshot` that runs the
    `select id, status, cost_usd, completed_at from tasks order by
    id desc limit 200` query through Drizzle.
  - `export const dynamic = "force-dynamic"` (no static caching).
  - `export const runtime = "nodejs"` — bun:sqlite needs Node
    runtime.
- Tests:
  - `tests/lib/sse.test.ts` — pure unit tests for
    `formatSseEvent`, `formatSseComment`, `diffTaskSnapshots`.
  - `tests/server/sse-tasks.test.ts` — integration tests for
    `createTaskStreamResponse` driven by a fake `readSnapshot`,
    short `pollMs`, and an `AbortController`. Reads the SSE wire
    bytes and asserts on `event:` / `data:` line shapes.
  - `tests/app/stream-tasks-route.test.ts` — smoke test that the
    route handler exists, has a default `GET` export, and returns
    a `Response` with the right `Content-Type`. Driven by a temp
    DB seeded with a few tasks (uses the same `BRIDGE_DB` override
    pattern as `tasks-router.test.ts`).

**Out:**

- BridgeBus / `update_hook` push side. v1 §5 mentions this for
  in-process mutations; we have **zero** mutations in Phase 1 (the
  read-only invariant), so polling is the only mechanism that ever
  fires anyway. BridgeBus is a Phase 2 addition once mutations land.
- Multiplex `/api/stream?topics=` — Phase 1 ships a single-topic
  endpoint. Phase 2+ may consolidate.
- Wiring the EventSource into the existing pages. The page
  components are server components (`/tasks`, `/agents`, etc.)
  that render at request time — adding a client subscription
  needs a `"use client"` shell that owns the live state. That's a
  T11 polish concern (live badge updates) once the empty/error
  state work is done. T08 ships the **server side**; the
  consumer comes later.
- Connection-pool bookkeeping (v1 §5 `polling chỉ chạy khi có ít
  nhất 1 SSE subscriber active`). Each request gets its own
  `setInterval`; per-process subscriber counting is a Phase 2 perf
  improvement.
- Authn / authz at the endpoint itself — the existing
  `middleware.ts` matcher (`/((?!_next/static|_next/image|favicon.ico).*)`)
  already gates `/api/stream/*` behind the env-password JWT.

## Acceptance criteria

1. `formatSseEvent("update", { id: 1, status: "done" })` returns
   `"event: update\ndata: {\"id\":1,\"status\":\"done\"}\n\n"`.
2. `formatSseEvent` handles a multi-line `string` payload by
   prefixing each line with `data: `.
3. `formatSseComment("hi")` returns `": hi\n\n"`.
4. `diffTaskSnapshots(emptyMap, [a, b])` emits two `update` events
   (one per task) and returns a 2-entry next snapshot.
5. `diffTaskSnapshots` emits **zero** events when `prev` and
   `curr` are byte-identical.
6. `diffTaskSnapshots` emits a single update when only one task
   changed `status` or `costUsd` or `completedAt`.
7. `diffTaskSnapshots` forgets tasks that drop out of the curr
   window — the next snapshot only contains ids present in `curr`.
8. `createTaskStreamResponse`:
   - Returns a `Response` with `Content-Type: text/event-stream`,
     `Cache-Control` containing `no-cache`, `X-Accel-Buffering:
     no`.
   - Writes an `init` event with `{ tasks: [...] }` on connect.
   - Writes an `update` event per changed task on each poll tick.
   - Writes a heartbeat comment (`": heartbeat"`) on the heartbeat
     cadence.
   - Aborting the `signal` clears intervals and closes the
     stream cleanly (no further bytes).
9. `app/api/stream/tasks/route.ts` exports `GET` returning a
   `Response` with `Content-Type: text/event-stream`. With a
   seeded `BRIDGE_DB`, the first frame's payload contains every
   seeded task id.
10. Read-only invariant:
    - GET-only handler — no `POST`/`PUT`/`PATCH`/`DELETE` exports
      from the route module.
    - The route never calls `getDb().insert/update/delete` — only
      `select`. Verified by inspection.
    - The handler never writes to disk.

## TDD plan

### Unit (`tests/lib/sse.test.ts`) — new file

1. `formatSseEvent` returns the expected canonical shape for a
   plain object.
2. `formatSseEvent` JSON-stringifies non-string data.
3. `formatSseEvent` splits a multi-line string into one `data:`
   line per `\n`-separated chunk (per SSE spec).
4. `formatSseComment` returns `": <text>\n\n"`.
5. `SSE_HEARTBEAT_COMMENT` is a non-empty string starting with
   `:`.
6. `diffTaskSnapshots(empty, [])` → no events, empty next
   snapshot.
7. `diffTaskSnapshots(empty, [a, b])` → 2 events, 2-entry next.
8. `diffTaskSnapshots(prevWithA, [a])` → no events when `a` is
   unchanged.
9. `diffTaskSnapshots(prevWithA, [aWithNewStatus])` → 1 event
   for the changed status.
10. `diffTaskSnapshots(prevWithA, [aWithNewCost])` → 1 event
    for the changed cost.
11. `diffTaskSnapshots(prevWithA, [aWithNewCompletedAt])` → 1
    event for the changed completion time.
12. `diffTaskSnapshots(prevWithAB, [a])` → next snapshot has
    only `a` (b dropped from window).

### Integration (`tests/server/sse-tasks.test.ts`) — new file

A fake `readSnapshot` returns a queue of arrays so the test can
deterministically advance the simulated state. `pollMs` is small
(20 ms) and `heartbeatMs` is small (50 ms) so the test runs in <
500 ms without flake.

1. Returns a `Response` with the SSE headers.
2. First chunk contains an `init` event with all initial tasks.
3. After one tick, emits an `update` for a newly-added task.
4. After one tick, emits an `update` for a status change.
5. After heartbeat cadence, emits a `: heartbeat` comment.
6. Aborting the signal closes the stream — no more chunks.

### Integration (`tests/app/stream-tasks-route.test.ts`) — new file

1. Route module exports a `GET` function (and not POST / PUT /
   etc).
2. Calling the GET handler with a seeded `BRIDGE_DB` returns a
   `Response` with `Content-Type: text/event-stream`. The first
   frame's `data:` line contains the seeded task ids.

## Notes / open questions

- **Polling only.** v1 §5 lists BridgeBus as the in-process push
  channel and 1s polling as the fallback for out-of-process
  mutations. Phase 1 has zero in-process mutations (read-only),
  so only the polling branch ever fires. We don't bother
  scaffolding the EventEmitter side until Phase 2 wires
  mutations.
- **LIMIT 200.** Tracking every task in a 10k-row DB would bloat
  the diff map and the wire payload. The most-recent 200 tasks
  cover ~7 days at our heaviest run rate; older tasks rarely
  change status anyway (already `done`/`failed`). When a task
  ages out of the window we forget its prev snapshot — that's
  fine because no further updates can happen to a finished task.
  If a daemon updates an ancient task somehow (re-run? unlikely
  in Phase 1), the dashboard sees it on next page load, just not
  via SSE. Document the corner case in the review.
- **Why a single-topic endpoint instead of `/api/stream?topics=`?**
  Phase 1 only has one live surface (tasks). Adding the topic-
  multiplex layer when there's only one topic is overengineering.
  When loops & agents grow live indicators (Phase 2), we can
  either extend this route to a query-param multiplex or add a
  second route. Either way the wire format stays the same — same
  `event: <topic>` / `data: <json>` framing.
- **Why `runtime = "nodejs"` and not Edge?** bun:sqlite is a
  native binding; the Edge runtime can't load it. The default in
  Next.js 15 is already `nodejs` for app-route handlers, but we
  pin it explicitly for clarity.
- **No `connection: keep-alive` header set.** HTTP/1.1's default
  is keep-alive, and Next.js / Node manages it. Setting it
  explicitly is harmless but redundant; we omit for simplicity.
- **Heartbeat cadence (15s).** SSE spec recommends ≤ 30s to
  defeat proxy idle-connection cuts. Our cloudflared tunnel
  default is 100s read timeout but Hetzner load balancers cut at
  60s. 15s is safe under both.
- **Why are we not piping events through the existing tRPC
  router?** tRPC v11 supports SSE subscriptions
  (`createSSEStreamProducer`), but the Phase-0 setup is barebones
  — no React Query client, no client subscription harness. A
  plain Next.js route + plain `EventSource` is simpler and the
  acceptance criterion ("dashboard cập nhật badge < 2s") doesn't
  require tRPC framing. We can migrate to tRPC subscriptions in
  Phase 2 when the client harness exists. Document this trade-off
  in the review.
- **What happens if the polling read fails (DB locked, etc)?**
  The tick wraps the read in `try/catch` and emits a single
  `error` event with the message; the next tick retries. We
  don't terminate the stream — the daemon may have just been
  doing a brief write.
- **Wire format for `update` events.** `{ id, status, costUsd,
  completedAt }`. The client merges these into its React Query
  cache for `tasks.list` / `tasks.listByAgent`. Phase 1 doesn't
  ship the client merge — that's a polish task. T08 just
  guarantees the wire is correct so the client work in T11 (or
  later) has something to consume.
- **Acceptance "< 2s lag from dispatch"**. Polling at 1s + ~
  100ms render means worst-case ~1.1s. Comfortable under the 2s
  budget.
- **Read-only confirm.** The route imports `getDb` and only
  calls `.select(...)`; the helper module imports nothing
  IO-related. No `INSERT`/`UPDATE`/`DELETE` anywhere in T08
  diff.
