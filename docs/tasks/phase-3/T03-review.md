# P3-T3 — `loops.start` mutation: code review

> Reviewer's pass over the T3 deliverables before commit. Anchored
> on the Phase 3 invariant checklist (CSRF + rate-limit + audit +
> optional confirmation) and the Phase 2 lessons we inherit.

## Files touched

| Path | Status | Lines |
|---|---|---|
| `src/server/dto.ts` | edit | +9 (`LoopStartResult`) |
| `src/server/routers/loops.ts` | edit | +138 (input schema, helpers, `start` procedure) |
| `src/lib/loop-start-client.ts` | new | 162 |
| `src/components/start-loop-dialog.tsx` | new | 503 |
| `app/loops/page.tsx` | edit | +9 (header layout + dialog mount) |
| `tests/server/loops-router.test.ts` | edit | +366 (19 new cases) |
| `tests/lib/loop-start-client.test.ts` | new | 12 cases |
| `tests/app/loop-start-dialog.test.ts` | new | 16 cases |
| `docs/tasks/phase-3/T03-start-loop.md` | new | task spec |
| `docs/tasks/phase-3/T03-review.md` | new | this file |

## Phase 3 invariant checklist

### 1. Calls daemon MCP tool — ✅
- `src/server/routers/loops.ts:start` calls
  `ctx.mcp.call("bridge_loop", params, { timeoutMs:
  LOOP_START_TIMEOUT_MS })`. Same call shape as Phase 2 T01 dispatch.
- No CLI spawn (`spawn`, `execSync`, etc. — checked via grep).
- No direct `INSERT INTO loops`, `INSERT INTO loop_iterations`, etc.
  — checked via grep on the procedure body.

### 2. Travels through MCP pool from `src/server/mcp/pool.ts` — ✅
- `ctx.mcp` is wired by
  `app/api/trpc/[trpc]/route.ts::createContext` from `getMcpPool()`.
- Tests inject a `fakePool` matching the `McpClient` interface. The
  procedure does not assume a concrete `McpPool` class.
- 15s timeout is a `CallOptions.timeoutMs` override — same as approve
  / reject from Phase 2 T06 (LOOP_TIMEOUT_MS = 15_000).

### 3. CSRF token — ✅
- POST entry handler (`app/api/trpc/[trpc]/route.ts`) runs
  `csrfGuard` for any non-safe method before the procedure body. No
  per-procedure plumbing required.
- Browser dialog reads `document.cookie` once on open via
  `readCsrfTokenFromCookie(document.cookie)`; sends `x-csrf-token`
  header via `buildLoopStartRequest`.
- Missing-cookie UX: dialog flips `csrfMissing=true`, disables submit,
  surfaces "session expired" hint. Form values preserved.
- Verified via existing `tests/server/csrf-guard.test.ts` — guard
  applies uniformly across `/api/trpc/*` POSTs.

### 4. Rate limit — ✅
- POST entry handler runs `rateLimitMutations` before the procedure.
  Same 30-mutations/min/user bucket as Phase 2.
- 429 response with `Retry-After` header surfaces in the dialog as a
  typed error code (`TOO_MANY_REQUESTS`) via `parseTrpcResponse`'s
  error-envelope branch — though the rate limiter sits at the route
  level, not the tRPC envelope, so 429 returns plain text. The
  dialog's `try { await fetch }` catches the non-2xx via `res.json()`
  parse failure → `LoopStartError("INTERNAL_SERVER_ERROR", ...)`. UX:
  the error banner shows up, form preserved.
- Could be tightened by handling the 429 status before parsing JSON
  — punted to a Phase 3 follow-up; same gap exists in dispatch
  dialog from Phase 2 T02.

### 5. Audit log entry — ✅
- `appendAudit({ ctx, action: "loop.start", resourceId: loopId,
  payload })` runs BEFORE the procedure returns. Test pins this
  shape via 19 server-test cases.
- `request_id` propagates through `ctx.req` → first-class per Phase 2
  lesson §4. Test asserts `payload.request_id` matches
  `/^[0-9a-f-]{36}$/`.
- Failure path: `appendAudit({ action: "loop.start.error",
  resourceId: null, payload: { ..., code } })` — runs before the
  TRPCError throw. Every `McpPoolError` code path tested.
- **Privacy** — `goal` text NEVER appears in `audit_log.payload_json`
  on either branch. Pinned by SECRET-substring tests on success,
  malformed-response, and every MCP error path.

### 6. Confirmation step — ✅ N/A
- Start is a **creation**, not destructive. INDEX §invariant
  explicitly excludes creation from DangerConfirm. T4 (cancel) and
  T7 (delete schedule) wrap with `<DangerConfirm>` per the same
  rule.

## Privacy precedent (§c)

- Goal text: forwarded to daemon via the `goal` MCP param; recorded
  in `audit_log.payload_json` only as `hasGoal: true`. Privacy
  invariant tested on:
  - happy-path success (text envelope and structured envelope)
  - malformed response error path
  - every MCP error code path
- Channel chat id: forwarded to daemon as `chat_id`; audit records
  `hasChannelChatId: true` sentinel only — same rule.
- User id: forwarded to daemon as `user_id`; audit records the JWT
  subject as `audit_log.user_id` (the dedicated column, not the
  payload), so privacy is the existing column-level rule from Phase
  2 T04.

## Optimistic UI scope decision (§d.1)

- **No optimistic for start** — server generates the loop_id; we
  cannot predict it client-side. UX: dialog shows "Starting…" while
  the request is in flight; on success, surfaces a `<Link>` to
  `/loops/[loopId]`. User clicks → navigates. Per INDEX §"Optimistic
  UI scope decision (carrying Phase 2 §d.1 forward)".
- The /loops list does NOT auto-add the new row — Next.js server
  component renders fresh on navigation. After dismissing the
  success state, refreshing the page picks up the new row from the
  daemon's DB write.

## Idempotency / multi-channel race

- Start is **not idempotent by id** (the daemon assigns a fresh
  `loop_id` per call), so there's no
  `alreadyStarted`-style sentinel like Phase 2 T03 (kill) or T06
  (approve/reject).
- Double-submit prevention is per-session: the dialog disables
  submit while the request is in flight (`status === "submitting"`).
  CSRF + rate limit catch the rest.

## Validation surface

- Every server-side Zod constraint has a matching client-side check:
  - `goal` 1..32_000 → server BAD_REQUEST + dialog disables submit
    when `goal.trim().length === 0`.
  - `doneWhen` regex → server regex + `isValidDoneWhen` client-side.
    `composeDoneWhen` enforces the bare `manual:` form for the
    manual preset's empty-value case.
  - `maxIterations` 1..200 → numeric input has `min/max/step`
    attributes + `isFormValid` numeric check.
  - `maxCostUsd` (0, 10_000] → `min={0.0001}` + numeric range check.
  - `passThreshold` 1..10 → integer range check.
- Zod schema rejects an out-of-range value with `BAD_REQUEST`; the
  dialog never sends one because submit is disabled. Defense in
  depth.

## Test coverage summary

- **Server (loops-router.test.ts)**: 19 new cases on top of the
  existing 58 → **77 total** (all pass).
- **Lib (loop-start-client.test.ts)**: 12 cases (all pass).
- **Component (loop-start-dialog.test.ts)**: 16 cases (all pass).
- **Integration**: covered by the existing CSRF + rate-limit guard
  tests via the route handler — Phase 2 T08 / T07 pin the gating
  pattern, T3's procedure inherits it.

## Things I did NOT do (deferred / out of scope)

- **`tasks.dispatch` daemon response shape mismatch** — the existing
  Phase 2 T01 test uses `{ task_id: 42 }` but the daemon's actual
  `bridge_dispatch` returns `text("Task #N dispatched...")`. Same
  drift exists for every MCP tool; daemon-side audit log + structured
  responses are filed against `claude-bridge` (per Phase 2 follow-up
  notes). T3 dual-handles both shapes for `bridge_loop` so we don't
  inherit the production-test drift; backporting that to dispatch is
  separate.
- **/loops list refresh after start** — no `router.refresh()` on
  success because the dialog redirects the user to `/loops/[loopId]`
  (T2's surface). The user can come back to /loops to see the new
  row. A future improvement: after dismissing the success state,
  call `router.refresh()` to pull a fresh list. Punted; UX is
  acceptable for a freshly-created loop the user wants to drill
  into.
- **429 status-code handling in dialog** — same gap as dispatch
  dialog (Phase 2 T02). The procedure is gated, so requests do get
  rate-limited; the dialog renders the failure as a generic
  INTERNAL_SERVER_ERROR. Would be nicer to surface "rate limited —
  try again in N seconds" via the `Retry-After` header; filed as a
  Phase 3 follow-up alongside the dispatch parity fix.
- **Goal-text linting** — no client-side checks for accidentally
  including secrets in the goal field. The privacy contract only
  applies to the audit log; the daemon legitimately needs the goal
  to drive the loop. Out of scope for the dashboard; would be a
  daemon-side feature.

## Final go/no-go

- Tests: 587 (Phase 2 baseline) + 47 new = **634 pass / 0 fail** for
  `bun test tests/lib tests/app tests/server`. Verified before
  commit.
- Build: `bun run build` clean, `/loops` route still 171 B + new
  client chunk for the dialog (verified before commit).
- Phase 3 invariant: every checkbox above ticks. Privacy precedent
  pinned by tests. No new abstractions beyond what the task
  required.

**Ship it.**
