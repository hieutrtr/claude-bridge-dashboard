# P2-T06 — review

## What landed

**New files (3):**

| File | Purpose | Lines |
|------|---------|------:|
| `src/server/routers/loops.ts` | New `loopsRouter` with `approve` + `reject` mutations. | 222 |
| `tests/server/loops-router.test.ts` | 37 integration tests for both procedures (active / finalized / race / error / privacy / idempotent). | 568 |
| `docs/tasks/phase-2/T06-loop-approve-reject.md` | TDD spec + acceptance + risk mitigation. | 270 |

**Modified files (2):**

| File | Change |
|------|--------|
| `src/server/dto.ts` | Added `LoopApproveResult` + `LoopRejectResult` wire shapes (both `{ ok: true, alreadyFinalized: boolean }`). |
| `src/server/routers/_app.ts` | Registered `loops: loopsRouter` on the appRouter. |

**Test count:** +37 (433 total `bun run test` green; 2925 expects). Typecheck clean.

## Self-review checklist

- [x] **Tests cover happy + error path.** 37 tests:
  - **`loops.approve`** (24 tests):
    - 1 happy-path active (`pending_approval=true` → MCP called → audit row).
    - 4 already-finalized server-side checks (`pa=false` × statuses `running/done/cancelled/failed`) → no MCP call → audit `alreadyFinalized:true`.
    - 9 race-pattern swallow (`already approved/rejected/finalized/finished/done`, `not pending approval`, etc.).
    - 1 generic RPC error (`daemon panic: out of memory`) — does not match race regex → `INTERNAL_SERVER_ERROR`.
    - 1 loop not found → `NOT_FOUND`, no audit, no MCP call.
    - 2 input validation (empty / oversize loopId → `BAD_REQUEST`).
    - 5 MCP error code → tRPC code mappings.
    - 1 context propagation (`userId=null` → audit `user_id` null).
    - 1 idempotency end-to-end (approve flips `pa=false` simulated → second approve hits early-return).
  - **`loops.reject`** (12 tests):
    - 1 happy-path with reason (verifies MCP `feedback` param, audit `hasReason: true`, **reason text never appears in `payload_json`**).
    - 1 happy-path without reason (verifies absence of `feedback` key in MCP params, no `hasReason` flag).
    - 1 already-finalized (`pa=false`, `status=done`, with reason supplied → no MCP call, reason still not echoed).
    - 4 race-pattern swallow.
    - 1 loop not found → `NOT_FOUND`.
    - 2 input validation (empty loopId, oversize reason → `BAD_REQUEST`).
    - 1 MCP error mapping (`MCP_TIMEOUT` → `TIMEOUT`, error path also redacts reason).
    - 1 multi-channel race end-to-end (`approve` succeeds, daemon flips `pa=false`, subsequent `reject` hits early-return — captures the headline race in §c.T06).
- [x] **Mutation has audit log entry.** Every non-validation outcome writes exactly one row:
  - Approve success (active) → `loop.approve`, payload `{ status, alreadyFinalized: false }`.
  - Approve server-side finalized → `loop.approve`, payload `{ status, alreadyFinalized: true }`.
  - Approve daemon race → `loop.approve`, payload `{ status, alreadyFinalized: true, raceDetected: true }`.
  - Approve pool error → `loop.approve.error`, payload `{ status, code }`.
  - Reject success (active) → `loop.reject`, payload `{ status, alreadyFinalized: false, hasReason? }`.
  - Reject server-side finalized → `loop.reject`, payload `{ status, alreadyFinalized: true }` (no `hasReason` — daemon never received it).
  - Reject daemon race → `loop.reject`, payload `{ status, alreadyFinalized: true, raceDetected: true }`.
  - Reject pool error → `loop.reject.error`, payload `{ status, code }`.
  - `NOT_FOUND` (unknown loopId) → no audit row (mirrors T03 — we don't log probes).
  - `BAD_REQUEST` (zod failure) → no audit row.
- [x] **CSRF token check.** Inherited from the route handler — `csrfGuard` runs before `fetchRequestHandler`. No per-call escape hatch.
- [x] **Rate limit applied.** Inherited from `rateLimitMutations` (30/min/user). The early-return `alreadyFinalized` path bypasses MCP entirely, so a user spamming Approve on a stale tab hits SQLite + audit only.
- [x] **Optimistic update + rollback.** **Explicitly out of scope per PHASE-2-REVIEW §d.1** — encoded in the task spec as a non-goal. Loops are server-confirmed; T10 wires optimistic updates only for `dispatch` + `kill`. Documented in the loops router header comment.
- [x] **Confirmation pattern for destructive action.** Out of scope — T11 ships the `<DangerConfirm>` primitive. Reject is destructive enough to warrant the confirmation in the eventual UI; the procedure side ships now.
- [x] **No secret leak.** Two privacy invariants verified by the test suite:
  - The reject `reason` is forwarded to the daemon as `feedback` but **never** persisted in `audit_log.payload_json` (verified on success, server-side-finalized, race-swallow, and pool-error paths via `expect(payload_json).not.toContain("bad output" / "too late" / "rationale")`).
  - The audit payload records only `{ status, alreadyFinalized, raceDetected?, code?, hasReason? }` — no goal text, no agent name (a loop's `agent` is implicit via `resource_id`), no daemon-internal state.
- [x] **Typed error codes for client.** Reuses `mapMcpErrorToTrpc` from T01 — same finite set of `TRPCError.code` values plus `NOT_FOUND` for unknown loopId. UI can switch on `error.code` to choose the right toast.
- [x] **No `child_process.spawn`.** Verified: the only transport is `ctx.mcp.call("bridge_loop_approve" / "bridge_loop_reject", ...)`.
- [x] **Idempotency two-layer guard.** Server-side `!pendingApproval` check (path A) handles the case where Telegram or another tab already finalized the loop; daemon-side race-pattern regex (path B) handles the narrow window where the dashboard's read is stale. The regex is intentionally tight — false positives on generic errors are demonstrated absent ("daemon panic" propagates as `INTERNAL_SERVER_ERROR`).
- [x] **Multi-channel race covered end-to-end.** The flagship test `loops — multi-channel race (approve then reject)` reproduces the §c.T06 risk: dashboard approves, daemon flips `pa=false`, dashboard then receives a reject (e.g. from a slow Telegram callback), and the procedure degrades gracefully to `alreadyFinalized: true` with a `loop.reject` audit row recording the *attempted* action.
- [x] **`resource_id` is the loop's text PK verbatim.** Unlike T03 where `resource_id = String(taskId)`, here `resource_id = input.loopId` directly so the audit viewer (T05) can join `audit_log.resource_id = loops.loop_id` without a cast.
- [x] **Test seam pattern matches T03.** On-disk tmp DB + `BRIDGE_DB` env + `resetDb()` for the read-side `loops` table; `__setAuditDb(getSqlite())` for audit isolation. The same composition T03 used.
- [x] **Distinct DTO types.** `LoopApproveResult` and `LoopRejectResult` are structurally identical today but kept separate so a future per-mutation extension (e.g. echoing iteration count post-approve) doesn't ripple across both procedures.

## Daemon command gap (still flagged from T12 / T01 / T03)

Same as T01 / T03 — `bridge mcp` does not exist in `claude-bridge` yet, so any production `loops.approve` / `loops.reject` call will surface as `MCP_SPAWN_FAILED → INTERNAL_SERVER_ERROR` until the daemon ships the subcommand. The procedure is correct and tested via fake-pool injection; the deployment gap is upstream and is recorded for the phase-2 sign-off doc (step 15).

## Risk delta vs spec

The T06 spec listed 7 risks. All mitigations landed as specified, with three concrete observations:

- **Privacy invariant verified at the byte level.** Tests assert `payload_json` does not contain the reason text on every code path that handles a `reject`-with-reason call (success, server-side finalized, daemon race, pool error). This is stronger than the spec's "do NOT echo reason" — `expect.not.toContain` would fail even if the reason were nested deep inside a forgotten payload key.
- **Two-DTO design accepted vs single shared `LoopActionResult`.** The spec proposed `LoopApproveResult` + `LoopRejectResult` as separate types even though the shape is identical. Kept the split — `dto.ts` adds 12 lines per type vs forcing every future divergence into a discriminated union; the wire cost is identical.
- **Server-confirmed UI is encoded structurally.** The procedure resolves `pendingApproval` before MCP and uses the daemon ACK to settle the audit row. There is no `optimisticPersist` flag the UI could turn on — the contract is "no UI flip until the mutation resolves". T10 will not be tempted to wire optimism into this surface because the result type carries no `.task` / `.loop` payload to optimistically render.

## Files touched

```
M  src/server/dto.ts                              (+24 -0)
M  src/server/routers/_app.ts                     (+5 -2)
A  src/server/routers/loops.ts                    (+222)
A  tests/server/loops-router.test.ts              (+568)
A  docs/tasks/phase-2/T06-loop-approve-reject.md  (+270)
A  docs/tasks/phase-2/T06-review.md               (this file)
```

## Verification

```
$ bun test tests/server/loops-router.test.ts
 37 pass
 0 fail
 202 expect() calls
Ran 37 tests across 1 file. [166ms]

$ bun run test
 433 pass
 0 fail
 2925 expect() calls
Ran 433 tests across 39 files. [2.20s]

$ bun run typecheck
$ tsc --noEmit            # clean
```

E2E Playwright smoke (`tests/e2e/`) is excluded from `bun run test` per `package.json` scripts and is run via `bun run test:e2e` separately. No regression risk introduced by T06 — the procedure surface is server-only.
