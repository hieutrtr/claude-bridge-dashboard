# P2-T12 — MCP client connection pool

> Foundation task. Lands first because every mutation procedure (T01, T03,
> T06, T09) calls into the pool. No mutation procedure should `Bun.spawn`
> a child of its own — they all go through `getMcpPool()`.

## References

- v2 ARCH §7.3 — "MCP stdio (optional, dashboard-as-client) — gọi tool từ UI"
  → mutations cho web flow đi qua MCP, reads thì query SQLite trực tiếp.
- v2 IMPLEMENTATION-PLAN P2-T12 — *"Reuse MCP stdio connection; reconnect
  on disconnect; backpressure khi daemon busy. Acceptance: 100 mutation
  song song không tạo 100 stdio process; latency p95 < 500 ms."*
- `docs/PHASE-2-REVIEW.md` §c risk-tier (T12 = **Medium**) and §d.5
  (cancel-mid-call: pool exposes per-request `AbortController`).
- MCP stdio framing: line-delimited JSON-RPC 2.0 (one JSON object per
  line, terminator `\n`). No `Content-Length` headers — that's HTTP
  Streamable transport.

## Acceptance criteria

1. **Single child for N concurrent requests.** 100 `pool.call()` invocations
   in parallel reuse exactly **one** spawned child process. Test asserts
   spawn count.
2. **Round-trip correctness.** Each `call(method, params)` resolves with
   the `result` field of the matching JSON-RPC response routed by `id`.
   Out-of-order responses are routed correctly (id 2 returning before id 1
   does not block id 1).
3. **Reconnect on EOF / EPIPE / exit.** When the child exits unexpectedly,
   any in-flight requests reject with `MCP_CONNECTION_LOST`. The next
   `call()` after exit transparently spawns a new child (lazy reconnect),
   subject to exponential backoff (250 ms, 500 ms, 1 s, 2 s, 4 s; cap 8 s)
   per-attempt. No crash loop on a permanently-dead command.
4. **Backpressure.** A bounded pending queue (default cap = 32). When the
   queue is full, new `call()`s reject **immediately** with `MCP_BACKPRESSURE`
   — they do **not** block. This protects the dashboard event loop from
   unbounded memory growth if the daemon hangs.
5. **Per-request `AbortController`.** `pool.call(method, params, { signal })`
   honors the abort signal: aborting before send removes from queue;
   aborting after send rejects the pending request and removes it from
   the routing map (does not poison subsequent responses with the same id
   — ids are monotonically incrementing per child, never reused).
6. **Per-request timeout.** Default 15 s. Rejects with `MCP_TIMEOUT`. Does
   not affect sibling requests.
7. **Graceful close.** `pool.close()` sends `SIGTERM`, waits ≤ 1 s for
   exit, then `SIGKILL`. All pending requests reject with
   `MCP_CONNECTION_CLOSED`. Idempotent (close twice = no-op).
8. **Latency budget.** p95 round-trip on a stub echo server < 500 ms for
   100 parallel calls. (Test asserts p95 < 500 ms — measured with
   `performance.now()`.)
9. **Process-singleton in production.** `getMcpPool()` returns a module-
   level instance; constructed lazily on first call. Tests use the
   constructor directly so they do not pollute the singleton.

## Non-goals

- HTTP Streamable / SSE MCP transport (out of scope; stdio only).
- TLS / auth on the MCP channel (stdio is local, OS-trust).
- Multi-replica connection pool (Phase 4 concern).
- Daemon-side MCP server changes — this is dashboard-side only.
- Probing whether `bridge mcp-stdio` subcommand exists in the daemon CLI.
  See **"Daemon command gap"** below — flagged as a follow-up.

## TDD plan (tests written first, RED → GREEN)

File: `tests/server/mcp-pool.test.ts` (Bun test)

A `tests/server/fixtures/mock-mcp-server.mjs` helper script implements a
minimal stdin/stdout JSON-RPC echo server with these methods:

- `echo` → returns `{ ok: true, echoed: <params> }`.
- `slow` → resolves after `params.ms` ms, returns the same shape.
- `crash` → calls `process.exit(1)` immediately (without responding).
- `out-of-order` → if `params.delay` provided, sleeps then responds — used
  to assert id-routing under interleaving.

Tests:

1. `call() returns the result of a single round-trip`.
2. `100 parallel calls reuse exactly one child process` (asserts spawn
   count = 1, all 100 resolve, p95 latency < 500 ms).
3. `out-of-order responses route by id` (slow id 1, fast id 2 → id 2
   resolves first; both correct).
4. `crash mid-call rejects in-flight requests with MCP_CONNECTION_LOST`.
5. `next call after crash transparently respawns and succeeds`.
6. `pool with cap=2 rejects 3rd queued call with MCP_BACKPRESSURE`.
7. `AbortController.abort() rejects the call and removes it from
   routing (subsequent unrelated call still works)`.
8. `timeout rejects with MCP_TIMEOUT after configured ms`.
9. `close() drains pending and rejects with MCP_CONNECTION_CLOSED`.
10. `close() is idempotent`.

## Implementation outline (`src/server/mcp/pool.ts`)

```
McpPool {
  private child?: ChildProcess
  private nextId = 1
  private pending = new Map<number, PendingCall>()
  private outBuf = ""              // partial line buffer
  private spawning?: Promise<ChildProcess>
  private state: "idle" | "starting" | "ready" | "closed"
  private backoffAttempt = 0       // exponential backoff counter
  private queueCap = 32
  private spawnFn               // injectable for tests
  private timeoutMs = 15_000

  call(method, params, { signal, timeoutMs }?): Promise<unknown>
  close(): Promise<void>
}
```

- Spawn defers until first `call()`. After exit, next call respawns.
- `stdout` parsed line-by-line (split on `\n`); each complete JSON line
  matched to `pending` by `id`. Notifications (`id` absent) are ignored
  for now (Phase 2 has no MCP notification consumers in the dashboard).
- Stderr piped to `process.stderr` with `[mcp-pool]` prefix — daemon
  log lines visible in dev. Production should redirect stderr to a file.
- All rejections use `class McpPoolError extends Error` with a `.code`
  field (`MCP_CONNECTION_LOST` | `MCP_BACKPRESSURE` | `MCP_TIMEOUT` |
  `MCP_CONNECTION_CLOSED` | `MCP_SPAWN_FAILED`).

## Daemon command gap (must flag in T12-review)

`bridge mcp-stdio` subcommand **does not exist** in the daemon CLI today
(verified by `grep -n "mcp" /Users/hieutran/projects/claude-bridge/src/cli/index.ts`
on 2026-05-06: only file/scaffold references, no command handler). Per
the INDEX "Caveat that would flip the decision" clause, this means:

- T12 ships **the pool itself** with a stub-tested implementation. Spawn
  command is **injectable** (constructor option `command`/`args`/`env`),
  defaulting to `["bridge", ["mcp"]]` so production code reads naturally.
- The `getMcpPool()` factory falls back to env var `CLAUDE_BRIDGE_MCP_COMMAND`
  for runtime override (operator escape hatch).
- T01 (dispatch) and the rest of the mutation tasks WILL fail end-to-end
  until the daemon adds `bridge mcp` (or equivalent). T12-review.md flags
  this as an upstream dependency.
- The loop does **not** abort on this — the foundation-first hybrid still
  works because the *pool* is correct and tested. Daemon enablement is a
  separate work item documented in PHASE-2-COMPLETE.md.

## Risk + mitigation (from PHASE-2-REVIEW §c)

| Risk | Mitigation in this task |
|------|-------------------------|
| Framing buffer corruption on partial reads | Tests #2 and #3 specifically interleave partial chunks via small `slow` delays; `outBuf` accumulator + `\n` split is the production code path being asserted. |
| Signal-handling on Bun.spawn | Use `node:child_process` (works in both Node and Bun); test #4 asserts in-flight reject path. |
| Cancel signal mid-call (review §d.5) | Test #7 uses `AbortController`; assert id-removal so subsequent calls are unaffected. |
| Two dashboard processes spawning concurrent stdio children | Out of scope for T12 — single-process pool only. Multi-replica deferred to Phase 4 (flagged in INDEX "Notes"). |
| Daemon `bridge mcp-stdio` does not exist yet | See **Daemon command gap** above. Pool is testable with a fixture mock-server; production wiring documented + env override. |
