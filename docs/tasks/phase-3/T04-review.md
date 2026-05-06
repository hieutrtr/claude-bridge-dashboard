# P3-T4 — Cancel + Approve / Deny gate UI: code review

> Reviewer's pass over the T4 deliverables before commit. Anchored on
> the Phase 3 invariant checklist (CSRF + rate-limit + audit +
> confirmation pattern) and the Phase 2 lessons we inherit.

## Files touched

| Path | Status | Lines |
|---|---|---|
| `src/server/dto.ts` | edit | +12 (`LoopCancelResult`) |
| `src/server/routers/loops.ts` | edit | +120 (input schema, `TERMINAL_LOOP_STATUSES`, `cancel` procedure) |
| `src/lib/loop-mutation-client.ts` | new | 119 |
| `src/components/loop-cancel-button.tsx` | new | 90 |
| `src/components/loop-approval-gate.tsx` | new | 257 |
| `src/components/loop-controls.tsx` | new | 67 |
| `app/loops/[loopId]/page.tsx` | edit | +6 (mounts `<LoopControls>`) |
| `tests/server/loops-router.test.ts` | edit | +266 (26 cancel cases) |
| `tests/lib/loop-mutation-client.test.ts` | new | 9 cases |
| `tests/app/loop-cancel-button.test.ts` | new | 8 cases |
| `tests/app/loop-approval-gate.test.ts` | new | 12 cases |
| `docs/tasks/phase-3/T04-cancel-approve.md` | new | task spec |
| `docs/tasks/phase-3/T04-review.md` | new | this file |

## Phase 3 invariant checklist

### 1. Cancel calls daemon MCP tool (NOT a direct table mutation) — ✅
- `src/server/routers/loops.ts:cancel` calls
  `ctx.mcp.call("bridge_loop_cancel", { loop_id }, { timeoutMs: 15_000 })`.
- No CLI spawn (`spawn`, `execSync`, etc. — checked via grep).
- No direct `INSERT/UPDATE INTO loops` — checked via grep on the
  procedure body. The daemon owns loop lifecycle.

### 2. Travels through MCP pool — ✅
- `ctx.mcp` is wired by `app/api/trpc/[trpc]/route.ts::createContext`
  from `getMcpPool()`. Tests inject a `fakePool` matching the
  `McpClient` interface — no fork.
- 15s timeout matches approve/reject from Phase 2 T06.

### 3. CSRF token — ✅
- POST entry handler runs `csrfGuard` before the procedure body.
- Browser components (`<LoopCancelButton>`, `<LoopApprovalGate>`) read
  `document.cookie` once via `readCsrfTokenFromCookie`; send
  `x-csrf-token` header via `buildLoopCancelRequest` /
  `buildLoopApproveRequest` / `buildLoopRejectRequest`.
- Missing-cookie UX: cancel button surfaces inside `<DangerConfirm>`
  which writes "Your session expired — reload the page to continue.";
  approval gate surfaces an amber banner above the buttons and
  disables both Approve and Deny.

### 4. Rate limit — ✅
- POST entry handler runs `rateLimitMutations` before the procedure.
  Same 30-mutations/min/user bucket as Phase 2.
- A `LOOP_CANCEL_URL` POST counts against the same bucket as a
  `dispatch` POST (route-level guard, not per-procedure).

### 5. Audit log entry — ✅
- `loops.cancel` writes an `audit_log` row in every code path:
  - Path A (terminal status, no MCP) — `action="loop.cancel"`,
    `payload={status, alreadyFinalized:true}`.
  - Path B (daemon race) — `action="loop.cancel"`,
    `payload={status, alreadyFinalized:true, raceDetected:true}`.
  - Path C (happy) — `action="loop.cancel"`,
    `payload={status, alreadyFinalized:false}`.
  - Path D (error) — `action="loop.cancel.error"`,
    `payload={status, code}`.
- `request_id` propagates through `ctx.req` → first-class per Phase 2
  lesson §4. Test asserts `payload.request_id` matches
  `/^[0-9a-f-]{36}$/`.
- Approve/reject audit shape unchanged from Phase 2 T06 — Phase 3
  reuses those procedures verbatim.

### 6. Confirmation step — ✅ (cancel only)
- Cancel wraps `<Button>` in `<DangerConfirm verb="Cancel"
  subject="loop XXXXXXXX…" expectedConfirmation={loopId.slice(0, 8)}>`.
- Approve / reject are NOT wrapped — Phase 3 INDEX explicitly carves
  this out (approve/reject *advance* the loop; cancel destroys it).
  Reject's inline reason form is itself a gentle pause, not a strict
  confirmation.

### 7. Optimistic UI — ✅ (none applied)
- Per Phase 3 INDEX §"Optimistic UI scope decision": skip optimistic
  for cancel/approve/reject — server-confirmed by design (race window
  vs Telegram, per Phase 2 T06 review §d.1).

## Component-level review

### `<LoopCancelButton>`
- Render policy mirrors `<KillTaskButton>` — suppressed for terminal
  statuses (done/cancelled/canceled/failed) and rendered for any
  non-terminal status. Defensive on `null` and unknown statuses.
- The `loopId.slice(0, 8)` confirmation token is exported as
  `LOOP_CANCEL_CONFIRM_LENGTH` so a future bump (e.g. to 12 chars) is
  a one-line change with a test that catches the contract.
- `onCancelled` callback is invoked from within `<DangerConfirm>`'s
  `onSuccess` — the parent's `<LoopControls>` calls `router.refresh()`
  there.
- Cross-bridges `LoopMutationError` → `DispatchError` so the
  DangerConfirm dialog (which only knows about `DispatchError`)
  surfaces the typed `code` + `message` correctly.

### `<LoopApprovalGate>` + `<LoopApprovalGateView>`
- View / wrapper split mirrors `<DangerConfirmView>` /
  `<DangerConfirm>` and `<StartLoopDialogView>` /
  `<StartLoopDialog>`. Tests assert the full state matrix on the View
  via `renderToStaticMarkup`.
- `idle` / `submitting-approve` / `submitting-reject` / `denying` /
  `resolved` / `error` are six discrete states; each renders a
  distinct UI surface. Pinned by 12 component-test cases.
- Reason validation: ≤ 1000 chars (matches the Zod cap on
  `loops.reject.reason`). Excess chars → red-border + disabled submit
  + visible "≤ 1000 characters" hint.
- Privacy hint inline: "Reason (optional — forwarded to the daemon,
  NOT logged in the audit trail)". A user who reads this will know
  the field is ephemeral on the dashboard side and not something a
  later audit forensics dive can recover.

### `<LoopControls>`
- Single-purpose composition wrapper. Owns the
  `useRouter().refresh()` closure shared by both children.
- `useRouter` wrapped in try/catch with a `window.location.reload()`
  fallback so the existing `tests/app/loop-detail.test.ts`
  `renderToStaticMarkup` flow keeps passing. In any real Next.js render
  the catch is dead code.
- The fallback is correct (just visually heavier) so the catch isn't
  a UX downgrade if some future SSR scenario lands there.

## Test coverage

### Server (`tests/server/loops-router.test.ts`) — 26 new cases for `loops.cancel`

| Concern | # cases |
|---|---|
| Happy path (running loop + pending_approval=true) | 2 |
| Already-finalized server-side check (4 statuses) | 4 |
| Daemon race (9 phrasings) | 9 |
| Generic MCP_RPC_ERROR (no race swallow) | 1 |
| Loop not found | 1 |
| Input validation (empty/oversize loopId) | 2 |
| MCP error mapping (TIMEOUT, BACKPRESSURE, CONNECTION_LOST, ABORTED) | 4 |
| Context propagation (anonymous user) | 1 |
| MCP context missing | 1 |
| Repeated-call idempotency | 1 |

### Browser libs (`tests/lib/loop-mutation-client.test.ts`) — 9 cases

| Concern | # cases |
|---|---|
| `buildLoopCancelRequest` / `buildLoopApproveRequest` URL+body+CSRF header | 2 |
| `buildLoopRejectRequest` reason omission/inclusion | 2 |
| `parseTrpcResponse` un-transformed + json-wrapped success | 2 |
| Error envelope code propagation + missing-code fallback | 2 |
| Malformed (null) envelope | 1 |

### Components (`tests/app/loop-cancel-button.test.ts`) — 8 cases

| Concern | # cases |
|---|---|
| Renders trigger for non-terminal statuses (running/pending/null/unknown) | 4 |
| Suppresses trigger for terminal statuses (done/cancelled/canceled/failed) | 4 |
| Confirmation prefix length contract | 1 (overlaps) |

### Components (`tests/app/loop-approval-gate.test.ts`) — 12 cases

| Concern | # cases |
|---|---|
| `idle` — Approve + Deny large buttons render | 1 |
| `idle` + csrfMissing — disabled + amber hint | 1 |
| `submitting-approve` / `submitting-reject` — Approving…/Denying… text + disabled | 2 |
| `denying` — reason form replaces button pair | 2 |
| `resolved` — banner copy varies by `alreadyFinalized` | 2 |
| `error` — code + message + fallback copy | 2 |
| Privacy: reason-not-logged hint visible | 1 |
| Reason > 1000 chars rejected visually | 1 (overlaps) |

## Build + typecheck

- `bun run test` (709 tests, 61 files) — all pass.
- `bun run typecheck` — clean (no new diagnostics).
- `bun run build` — clean. `/loops/[loopId]` route size went from
  ~0 KB stub to 2.92 KB (the new client island).

## Risks accepted

- **`useRouter` try/catch.** Strictly speaking, calling a hook inside
  try/catch is unusual. The catch path runs only when the
  `AppRouterContext` is missing — i.e. in the
  `renderToStaticMarkup` test path or possibly in a future SSR
  streaming scenario. The hook call order doesn't change between
  renders, so React's invariant holds. We documented this in-line
  and the fallback (`window.location.reload()`) keeps the user-
  visible behaviour correct.
- **Cancel does not poll-then-snapshot status.** After the daemon
  acks, we call `router.refresh()`. There is a sub-second window
  where the polling-free server fetch returns the daemon's
  intermediate state. Acceptable per Phase 3 INDEX (no SSE
  multiplex this phase).
- **Reject reason is forwarded to the daemon but ephemeral on the
  dashboard.** Any review of "what feedback did they send" must read
  `loop.feedback` from the daemon DB. The audit log records only
  `hasReason: true`. This is the same privacy contract as Phase 2 T06.

## Sign-off

All 7 invariant checklist items met. 55 new test cases (26 server +
9 lib + 8 + 12 component) cover happy / race / error / validation /
context paths. Build + typecheck clean. Ready to commit as
`feat(phase-3): T04 cancel + approve gate UI`.
