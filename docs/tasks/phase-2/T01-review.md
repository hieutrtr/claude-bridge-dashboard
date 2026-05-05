# P2-T01 — review

## What landed

**New files (3):**

| File | Purpose | Lines |
|------|---------|------:|
| `src/server/mcp/errors.ts` | `mapMcpErrorToTrpc` + `auditFailureCode` — shared by T01/T03/T06. | 86 |
| `tests/server/dispatch-router.test.ts` | 16 integration tests for the mutation (happy path, validation, error mapping, audit). | 365 |
| `docs/tasks/phase-2/T01-dispatch.md` | TDD spec + acceptance + risk mitigation. | 291 |

**Modified files (5):**

| File | Change |
|------|--------|
| `src/server/trpc.ts` | Context widened from `Record<string, never>` to `{ req?, userId?, mcp? }` so mutation procedures get request + transport. |
| `src/server/mcp/pool.ts` | Exported `McpClient` interface (test injection seam) + `__setMcpClientForTests`. `getMcpPool()` return type widened to `McpClient`. |
| `app/api/trpc/[trpc]/route.ts` | `createContext` now populates `req`, `userId`, `mcp = getMcpPool()`. |
| `src/server/dto.ts` | Added `DispatchResult` wire shape `{ taskId: number }`. |
| `src/server/routers/tasks.ts` | New `dispatch` mutation: Zod input → MCP `bridge_dispatch` → audit success/failure → return `{ taskId }`. |

**Test count:** +16 (370 total bun-test green; 2584 expects). Typecheck clean.

## Self-review checklist

- [x] **Tests cover happy + error path.** 16 tests:
  - 4 happy-path (return shape, optional `model`, multi-line/unicode prompt round-trip, `userId=null`).
  - 3 input-validation (empty prompt, empty agent, prompt > 32_000).
  - 1 malformed daemon response.
  - 6 MCP error code → tRPC code mappings (TIMEOUT, BACKPRESSURE, CONNECTION_LOST, SPAWN_FAILED, ABORTED, RPC_ERROR).
  - 1 RPC error message preservation.
  - 1 non-pool error fallback.
- [x] **Mutation has audit log entry.** Both success (`task.dispatch`, `resource_id=String(taskId)`) and failure (`task.dispatch.error`, `payload.code`) write rows. The failure row goes in *before* the throw so an aborted client still leaves an audit trail. Verified in tests #1 and the 6 error-mapping cases.
- [x] **CSRF token check.** Inherited from the route handler — `csrfGuard` runs before `fetchRequestHandler`. Mutations on POST without a matching token return 403 + audit row (T08 path); the `dispatch` procedure itself doesn't need a per-procedure check.
- [x] **Rate limit applied.** Inherited from `rateLimitMutations` in the route handler (30/min/user, 429 + audit on overflow). The procedure has no per-call escape hatch.
- [x] **Optimistic update + rollback.** Out of scope for T01 — that's T10 (and the spec deliberately bills T10 against `dispatch` + `kill` only). Server side is server-confirmed today.
- [x] **Confirmation pattern for destructive action.** Dispatch is *constructive* (creates a task) so confirmation is not required by the design (T11 confirmation pattern is for kill / cancel-loop). UI dialog (T02) will surface a cost-estimate placeholder which is a different UX guard.
- [x] **No secret leak.** The audit row deliberately *excludes* the prompt. Only `agentName` + `model` go into `payload_json`; the prompt lives on `tasks.prompt` in the daemon DB. The audit log is owner-only (T05) but defense in depth means we still don't duplicate prompt text.
- [x] **Typed error codes for client.** `mapMcpErrorToTrpc` produces a finite set of `TRPCError.code` values (`TIMEOUT` / `TOO_MANY_REQUESTS` / `INTERNAL_SERVER_ERROR` / `CLIENT_CLOSED_REQUEST`); tests assert each one. The dispatch dialog (T02) can switch over `error.code` to render the right toast.
- [x] **No `child_process.spawn`.** Verified: the only transport is `ctx.mcp.call(...)`. `bun:sqlite` access stays read-side; the daemon owns task lifecycle.
- [x] **Multi-line prompt round-trip.** Test #3 sends `"line1\nline2\n  with\ttabs\nemoji 🎉\n\"quoted\"\\backslash"` and asserts byte-identical recovery on the MCP-side fake. The pool's `JSON.stringify` framing is utf-8 safe.
- [x] **Singleton not polluted.** The procedure uses `ctx.mcp` (injected by tests) — not `getMcpPool()` directly. `__setMcpClientForTests(null)` is available but unused for T01 (context injection is sufficient).
- [x] **Test seam pattern matches T07/T08/T04.** `__setAuditDb(db) + __resetAudit() + tmp DB + runMigrations` mirrors `audit-integrations.test.ts` exactly.

## Daemon command gap (still flagged from T12)

`bridge mcp` does not exist in `claude-bridge` yet (per T12-mcp-pool.md). End-to-end Phase 2 mutations **will fail** in production until the daemon ships the subcommand — they'll surface as `MCP_SPAWN_FAILED → INTERNAL_SERVER_ERROR` toast. The dispatch procedure is correct and tested via injection; the deployment gap is upstream and is recorded in `PHASE-2-COMPLETE.md` once we get there.

## Risk delta vs spec

The T01 spec (`docs/tasks/phase-2/T01-dispatch.md`) listed 7 risks. All mitigations landed as specified, with one concrete observation:

- **Audit-write-after-throw race.** Implementation puts `appendAudit(...)` *before* `throw mapMcpErrorToTrpc(err)` in the catch block — exactly as the spec required. bun:sqlite is synchronous so there is no observable race even under abort.
- **PII in audit payload.** The audit `payload_json` contains only `{ agentName, model? }` (success) or `{ agentName, model?, code }` (failure). The prompt is *deliberately* absent — verified in test #1 by JSON-parsing the row and asserting the keys.

## Files touched

```
M  app/api/trpc/[trpc]/route.ts          (+8 -3)
M  src/server/dto.ts                     (+9)
M  src/server/mcp/pool.ts                (+22 -5)
M  src/server/routers/tasks.ts           (+126 -2)
M  src/server/trpc.ts                    (+18 -7)
A  src/server/mcp/errors.ts              (+86)
A  tests/server/dispatch-router.test.ts  (+365)
A  docs/tasks/phase-2/T01-dispatch.md    (+291)
A  docs/tasks/phase-2/T01-review.md      (this file)
```

## Verification

```
$ bun test tests/server/dispatch-router.test.ts
 16 pass
 0 fail
 79 expect() calls

$ bun test tests/lib tests/app tests/server
 370 pass
 0 fail
 2584 expect() calls

$ bun run typecheck
$ tsc --noEmit
(clean exit)
```

## Follow-ups (not blocking)

- **T03 (kill)** will call `mapMcpErrorToTrpc` directly — no rework expected; the helper is already exported.
- **T06 (loops.approve/reject)** same — server-confirmed mutations both reuse the helper.
- **T02 (dispatch dialog)** can switch on `error.code` for the toast — the discriminated union is stable.
- **T10 (optimistic UI)** will add `onMutate`/`onError` rollback for `tasks.dispatch`. The server-side contract (return `{ taskId }`) won't change.
- **Daemon `bridge mcp` subcommand** — already filed upstream by T12-review; T01 doesn't add new urgency since the helper-only path is already correct.
