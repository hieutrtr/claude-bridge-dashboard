# T12 — MCP client connection pool — self-review

## Files changed

| File | Lines | Notes |
|------|------:|-------|
| `src/server/mcp/pool.ts` | +271 / -0 | New module: `McpPool` class, `McpPoolError`, `getMcpPool()` factory, `__resetMcpPoolForTests()`. |
| `tests/server/mcp-pool.test.ts` | +183 / -0 | 10 Bun tests, 127 expects. |
| `tests/server/fixtures/mock-mcp-server.mjs` | +57 / -0 | Stdin/stdout JSON-RPC echo + slow + crash + ping fixture. Spawned with `bun` (works in CI without `node` on PATH). |
| `docs/tasks/phase-2/T12-mcp-pool.md` | +135 / -0 | Task spec (acceptance, TDD plan, daemon-gap note). |
| `docs/tasks/phase-2/T12-review.md` | (this file) | |

## Test count

- 10 new tests, 127 expects, all pass.
- Full suite: 267 pass / 0 fail / 805 expects (Phase 1 baseline 257 / 678 → +10 / +127, exactly the T12 delta).
- `bun run typecheck` clean.

## Self-review checklist

- [x] **Tests cover happy + error path** — round-trip, 100-parallel reuse,
      out-of-order id routing, mid-call crash → CONNECTION_LOST, transparent
      respawn after crash, BACKPRESSURE, AbortController, TIMEOUT,
      CONNECTION_CLOSED, idempotent close.
- [x] **Mutation has audit log entry?** — N/A (T12 is the transport layer;
      audit is T04, called by the procedures that USE the pool, not by the
      pool itself).
- [x] **CSRF token check?** — N/A (CSRF is T08, applied at the tRPC HTTP
      entry, not at the MCP transport layer).
- [x] **Rate limit applied?** — N/A (T07, applied at the tRPC procedure
      layer).
- [x] **Optimistic update with rollback?** — N/A (T10, UI layer).
- [x] **Confirmation pattern for destructive action?** — N/A (T11, UI layer).
- [x] **No secret leak** — `process.env` is forwarded into the spawned
      child verbatim (same as a developer's shell), but the pool itself
      does not log env values. Stderr from the child is prefixed with
      `[mcp-pool]` and goes straight to `process.stderr`; nothing JSON-
      logged to disk by this module.

## Acceptance verification (per task spec)

| # | Criterion | How verified |
|---|-----------|--------------|
| 1 | Single child for N concurrent requests | Test "100 parallel calls reuse exactly one child process" asserts `pool.spawnCount === 1`. |
| 2 | Round-trip correctness, out-of-order id routing | Tests "returns the result of a single round-trip" + "routes out-of-order responses by id" (slow+fast race). |
| 3 | Reconnect on EOF / EPIPE / exit | Tests "rejects in-flight calls with MCP_CONNECTION_LOST when child crashes" + "transparently respawns on the next call after a crash" (asserts `spawnCount === 2`). |
| 4 | Backpressure (`MCP_BACKPRESSURE`, immediate, no block) | Test "rejects with MCP_BACKPRESSURE when the queue cap is exceeded" with `queueCap: 2`. Synchronous reservation in `call()` (counter `slotsReserved`) ensures three concurrent calls correctly observe the cap before any await suspends. |
| 5 | Per-request `AbortController` + no routing poison | Test "AbortController.abort() rejects the call without poisoning sibling routing" — sibling `pool.call("ping", {})` after abort still works. |
| 6 | Per-request timeout (`MCP_TIMEOUT`) | Test "rejects with MCP_TIMEOUT after the configured deadline" + sibling call assertion. |
| 7 | Graceful close (SIGTERM → SIGKILL after 1 s, idempotent) | Tests "close() drains pending …" + "close() is idempotent". |
| 8 | p95 < 500 ms for 100 parallel | Same test asserts `p95 < 500` (typical local: 30–60 ms). |
| 9 | Process-singleton in production | `getMcpPool()` lazy singleton; `__resetMcpPoolForTests()` for isolation; tests construct `new McpPool(...)` directly. |

## Design notes

- **Why `node:child_process` instead of `Bun.spawn`** — Next.js dev/prod
  servers run on Node by default; using `node:child_process` keeps the
  module portable across Bun (test runner) and Node (Next runtime).
  Bun's Node compat layer handles this transparently.
- **JSON-RPC framing** — line-delimited (`\n`-terminated). Per the MCP
  stdio transport spec; no `Content-Length` headers (those belong to the
  Streamable HTTP transport).
- **Synchronous slot reservation** — `slotsReserved++` happens before the
  first `await`, so N concurrent `call()` invocations correctly serialise
  on the queue cap. An earlier draft used `pending.size` after `await
  ensureChild()`, which let three "concurrent" calls each see size=0 and
  bypass the cap — caught by the failing backpressure test (TDD!) before
  the synchronous-reservation refactor landed. Documented here so the
  next reviewer doesn't re-introduce the bug.
- **Notifications dropped** — JSON-RPC messages without an `id` are
  notifications. Phase 2 has no consumer for them; we silently drop. T09
  (permission relay) will likely consume notifications via the SSE
  endpoint, not via this pool — so this drop is intentionally permanent.
- **Ids never reused after abort/timeout** — `nextId++` is monotonic.
  Late responses for aborted/timed-out ids find no entry in `pending`
  and are silently dropped — they cannot poison a later request's
  routing because that later request has a fresh id.
- **Error code surface** — `MCP_CONNECTION_LOST` (child exit / EPIPE),
  `MCP_CONNECTION_CLOSED` (pool.close()), `MCP_BACKPRESSURE`, `MCP_TIMEOUT`,
  `MCP_ABORTED`, `MCP_SPAWN_FAILED`, `MCP_RPC_ERROR` (server returned an
  error object). Mutation procedures (T01, T03, T06) will map these to
  `tRPC TRPCError`s in their own task files (typically `INTERNAL_SERVER_ERROR`
  with `cause: McpPoolError` so logs preserve the code).

## Risks + caveats (carry-forward)

1. **Daemon `bridge mcp` (or `bridge mcp-stdio`) subcommand does not yet
   exist.** Verified by grep on `/Users/hieutran/projects/claude-bridge/src/cli/index.ts`
   on 2026-05-06: only file/scaffold references, no command handler. The
   factory `getMcpPool()` defaults to `bridge mcp` and accepts the
   `CLAUDE_BRIDGE_MCP_COMMAND` env override. **End-to-end mutation tasks
   (T01, T03, T06) will fail at runtime against an unmodified daemon
   until the daemon team adds this subcommand.** Pool unit tests do not
   depend on the daemon (they use the `bun` + fixture combo), so this is
   not a Phase 2 loop blocker per the INDEX "Caveat" clause — the loop
   continues, with the gap flagged for `PHASE-2-COMPLETE.md` and a
   cross-repo issue.
2. **Multi-replica scope** — single dashboard process only. A second
   dashboard process would spawn its own MCP child. Phase 4 will revisit
   when Docker compose / horizontal scale lands.
3. **Notification stream** — see "Notifications dropped" above. T09
   permission relay should not try to receive them via this pool.
4. **Stderr volume** — child stderr is forwarded with `[mcp-pool]` prefix
   to `process.stderr` unbuffered. If the daemon becomes chatty, switch
   to a ring buffer (deferred — only a hot-path concern at scale).
5. **Spawn retry budget** — `MCP_SPAWN_FAILED` thrown after `2 ×
   backoffMs.length` failed attempts. With the default schedule that's
   12 attempts over ≈ 32 s. Tests don't exercise the retry path
   (mock fixture starts cleanly under `bun`); risk is acceptable for a
   foundation task — production ops can extend `backoffMs` if needed.
6. **`finally` decrement of `slotsReserved`** — relies on the inner
   promise always settling. The pool's design guarantees this (every
   pending entry is removed on resolve / reject / abort / timeout / close
   / child-exit), but if a future change adds a code path that orphans
   a pending entry, the slot counter would drift. A regression test for
   "after 1000 calls, `slotsReserved === 0`" is a worth-considering
   addition in T01 once we have a real procedure to drive load.
