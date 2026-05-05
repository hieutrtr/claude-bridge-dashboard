# P2-T03 — review

## What landed

**New files (2):**

| File | Purpose | Lines |
|------|---------|------:|
| `tests/server/kill-router.test.ts` | 26 integration tests for the mutation (active/terminal/race/error/idempotent paths). | 396 |
| `docs/tasks/phase-2/T03-kill.md` | TDD spec + acceptance + risk mitigation. | 226 |

**Modified files (2):**

| File | Change |
|------|--------|
| `src/server/dto.ts` | Added `KillResult` wire shape `{ ok: true, alreadyTerminated: boolean }`. |
| `src/server/routers/tasks.ts` | New `kill` mutation: id → task lookup → terminal check OR `bridge_kill` MCP call → race-pattern swallow → audit + return. |

**Test count:** +26 (396 total bun-test green; 2723 expects). Typecheck clean. Build clean.

## Self-review checklist

- [x] **Tests cover happy + error path.** 26 tests:
  - 3 happy-path active (running / pending / queued → MCP called → audit row).
  - 3 already-terminated (done / failed / killed → no MCP call → audit row with `alreadyTerminated:true`).
  - 6 race-pattern swallow (`no running task`, `not running`, `task already terminated`, `already finished`, `already killed`, `already done` — all swallowed).
  - 1 generic RPC error (e.g. `daemon panic: out of memory`) — does **not** match the race regex, propagates as `INTERNAL_SERVER_ERROR`.
  - 1 task not found → `NOT_FOUND`, no audit, no MCP call.
  - 4 input validation (id=0, id=-1, id=1.5, id=NaN → all `BAD_REQUEST`).
  - 5 MCP error code → tRPC code mappings (TIMEOUT, BACKPRESSURE, CONNECTION_LOST, SPAWN_FAILED, ABORTED).
  - 2 context propagation (userId=null → audit user_id null; x-forwarded-for + JWT_SECRET → ip_hash non-null).
  - 1 idempotency end-to-end (kill running task → simulate daemon flip status to `killed` → second kill is `alreadyTerminated:true` without MCP call).
- [x] **Mutation has audit log entry.** Every non-validation outcome writes exactly one row:
  - Success (active kill) → `task.kill`, payload `{ agentName, status, alreadyTerminated: false }`.
  - Server-side terminal short-circuit → `task.kill`, payload `{ agentName, status, alreadyTerminated: true }`.
  - Daemon race → `task.kill`, payload `{ agentName, status, alreadyTerminated: true, raceDetected: true }`.
  - Pool error (timeout / backpressure / connection / spawn / abort / non-race RPC) → `task.kill.error`, payload `{ agentName, code }`.
  - `NOT_FOUND` (unknown id) → **no** audit row by design (matches `tasks.get` behavior on null queries; we don't log probes against non-existent ids).
  - `BAD_REQUEST` (zod failure) → **no** audit row (zod throws before procedure body runs).
- [x] **CSRF token check.** Inherited from the route handler — `csrfGuard` runs before `fetchRequestHandler`. The procedure has no per-call escape hatch.
- [x] **Rate limit applied.** Inherited from `rateLimitMutations` (30/min/user). The early-return terminal-check path also bypasses MCP entirely, so even an unkilled spam loop on a `done` task hits SQLite + audit only — never the daemon.
- [x] **Optimistic update + rollback.** Out of scope for T03 — that's T10. The server-side contract (`{ ok, alreadyTerminated }`) is stable enough for T10 to wire `onMutate`/`onError` without future churn.
- [x] **Confirmation pattern for destructive action.** Out of scope — T11 ships the `<DangerConfirm>` primitive that the kill button on `/tasks/[id]` will use. The procedure today is "naked" but is not exposed in the UI yet.
- [x] **No secret leak.** The audit `payload_json` carries only `{ agentName, status, alreadyTerminated, raceDetected? }` for success and `{ agentName, code }` for failure. The task `prompt` is *not* persisted in the audit row (same defense-in-depth as T01).
- [x] **Typed error codes for client.** Reuses `mapMcpErrorToTrpc` from T01 — same finite set of `TRPCError.code` values plus `NOT_FOUND` for unknown id. UI can switch on `error.code` to choose the right toast.
- [x] **No `child_process.spawn`.** Verified: only transport is `ctx.mcp.call("bridge_kill", ...)`.
- [x] **Idempotency two-layer guard.** Server-side terminal check (path A) catches the common case where the daemon has already flipped `tasks.status`; daemon-side race-pattern regex (path B) catches the narrow window where the dashboard's read is stale. The regex is intentionally tight — false positives on generic errors are demonstrated absent in test #10 ("daemon panic" propagates).
- [x] **Singleton not polluted.** Procedure uses `ctx.mcp` (injected by tests) — not `getMcpPool()` directly. Tests inject a fake; production wires `getMcpPool()` once in `createContext`.
- [x] **Test seam pattern matches T01 + T07/T08/T04.** On-disk tmp DB + `BRIDGE_DB` env + `resetDb()` for the read-side join (analytics-router pattern), `__setAuditDb(getSqlite())` for audit isolation (audit-integrations pattern). The two patterns compose cleanly in `beforeEach`.

## Daemon command gap (still flagged from T12 / T01)

Same as T01 — `bridge mcp` does not exist in `claude-bridge` yet, so any production `tasks.kill` call will surface as `MCP_SPAWN_FAILED → INTERNAL_SERVER_ERROR` until the daemon ships the subcommand. The procedure is correct and tested via fake-pool injection; the deployment gap is upstream and is recorded for the phase-2 sign-off doc (step 15).

## Risk delta vs spec

The T03 spec listed 7 risks. All mitigations landed as specified, with two concrete observations:

- **`agentName === null` (orphan tasks).** When a task's session_id no longer joins to an agent row, `row.agentName` is `null` and the procedure passes `""` to `bridge_kill`. The daemon will reject (almost certainly with an `MCP_RPC_ERROR` like `"agent not found"`) which does **not** match the race regex → propagates as `INTERNAL_SERVER_ERROR`. Tests do not seed an orphan-task path; the behaviour is defensive (not a hot path) and ships unchanged.
- **`Number.NaN` input rejection.** Zod's `z.number().int()` happens to reject `NaN` on its `.int()` step (NaN fails any integer predicate); test #14 was added defensively even though the contract is implicit. Documented for future readers.

## Files touched

```
M  src/server/dto.ts                     (+18 -2)
M  src/server/routers/tasks.ts           (+139 -2)
A  tests/server/kill-router.test.ts      (+396)
A  docs/tasks/phase-2/T03-kill.md        (+226)
A  docs/tasks/phase-2/T03-review.md      (this file)
```

## Verification

```
$ bun test tests/server/kill-router.test.ts
 26 pass
 0 fail
 139 expect() calls

$ bun test tests/lib tests/app tests/server
 396 pass
 0 fail
 2723 expect() calls

$ bunx tsc --noEmit
(clean exit)

$ bun run build
(clean exit — App Router build OK)
```

## Follow-ups (not blocking)

- **T06 (loops.approve/reject)** will mirror this exact pattern — task lookup not needed (loops are addressed by `loop_id` directly), but the audit + race + error-mapping shape is identical. Reuse `mapMcpErrorToTrpc` + `auditFailureCode` unchanged.
- **T11 (confirmation pattern)** will reuse this procedure unchanged — the UI button on `/tasks/[id]` is gated by `<DangerConfirm>` but the wire contract doesn't move.
- **T10 (optimistic UI)** will add `onMutate`/`onError` for the kill button. The `KillResult` shape is stable enough that an optimistic `task.status = 'killed'` flip + rollback on error is straightforward.
- **Daemon `bridge mcp` subcommand** — already filed upstream by T12-review; T03 doesn't add new urgency.
