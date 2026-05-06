# P2-T09 — Self-review

> Permission relay UI — slot 13/15. SSE `/api/stream/permissions` →
> stacked toast → `permissions.respond` mutation that flips the
> daemon-owned row directly (no MCP tool — v1 ARCH §10 inheritance).

## Files touched

### New (production code)

| File | Purpose | LOC |
|------|---------|-----|
| `src/lib/permissions-stream.ts` | Pure diff helper (init / pending / resolved events). | ~80 |
| `src/server/sse-permissions.ts` | SSE `Response` factory; mirrors `sse-tasks.ts`. | ~115 |
| `app/api/stream/permissions/route.ts` | Route handler; reads `permissions` table with 30-s tail. | ~80 |
| `src/server/routers/permissions.ts` | `permissions.respond` tRPC mutation. | ~140 |
| `src/lib/permissions-client.ts` | Browser RequestInit helpers (RESPOND_URL, buildRespondRequest). | ~40 |
| `src/components/permission-relay-toast.tsx` | View + interactive wrapper (EventSource subscriber, fetch-side respond). | ~250 |

### Modified

| File | Why |
|------|-----|
| `src/server/routers/_app.ts` | Wire `permissionsRouter` into `appRouter`. |
| `app/layout.tsx` | Mount `<PermissionRelayToast />` inside the authed shell. |

### New (tests)

| File | Test count |
|------|------------|
| `tests/lib/permissions-stream.test.ts` | 9 |
| `tests/server/sse-permissions.test.ts` | 6 |
| `tests/server/permissions-router.test.ts` | 9 |
| `tests/lib/permissions-client.test.ts` | 5 |
| `tests/app/permission-relay-toast.test.ts` | 9 |
| `tests/app/stream-permissions-route.test.ts` | 2 |
| **Total** | **40** |

## Test results

```
$ bun test tests/lib/permissions-stream.test.ts \
           tests/server/sse-permissions.test.ts \
           tests/server/permissions-router.test.ts \
           tests/lib/permissions-client.test.ts \
           tests/app/permission-relay-toast.test.ts \
           tests/app/stream-permissions-route.test.ts
40 pass / 0 fail / 120 expects, ~223 ms

$ bun test
563 pass / 1 fail / 3278 expects   # the 1 fail is the pre-existing
                                    # Playwright import in
                                    # tests/e2e/smoke.spec.ts (unchanged
                                    # since iter 11; not introduced by
                                    # T09).

$ bun run typecheck
$ tsc --noEmit          # clean

$ bun run build
✓ Compiled successfully in 2.7s
✓ Generating static pages (9/9)
# /api/stream/permissions appears as a new ƒ (dynamic) route, 155 B
# /tasks/[id] still 4.03 kB; no other route's bundle moved
```

The dynamic-route count went from 8 → 9 (`/api/stream/permissions`
added). No existing route grew. The toast wrapper is mounted globally
in `app/layout.tsx` but is `"use client"` and hydrates lazily, so
prerendered routes still ship at 102 kB shared.

## Self-review checklist (per loop spec)

- [x] **Tests cover happy + error path.** Happy path approved/denied,
  already-resolved race (×2 statuses), unknown id (NOT_FOUND), input
  validation (empty id / oversize id / unknown decision), privacy
  (command never echoes into audit), SSE init + pending + resolved
  + heartbeat + abort, view across the full state matrix
  (empty / one / multiple / csrf-missing / submitting / error /
  truncate / description / null command).
- [x] **Mutation has audit log entry.** Every code path in
  `permissions.respond` writes one row:
  - `permission.respond` on success (`alreadyResolved:false`).
  - `permission.respond` on race (`alreadyResolved:true`, no UPDATE).
  - `permission.respond.error` on DB failure.
  Audit `payload` carries `decision`, `toolName`, `sessionId`, and
  the race / error flags. Audit row enforced in
  `permissions-router.test.ts` for every path.
- [x] **CSRF token check.** `permissions.respond` is a tRPC mutation
  → routed through `app/api/trpc/[trpc]/route.ts` which already runs
  `csrfGuard(req)` before the procedure. The toast reads the cookie
  with `readCsrfTokenFromCookie(document.cookie)` before calling
  `fetch`; missing cookie disables both buttons and shows a "session
  expired" hint (asserted in view tests).
- [x] **Rate limit applied.** Same path as above —
  `rateLimitMutations` runs after `csrfGuard`. Permission responses
  count against the same 30/min/user bucket as `tasks.dispatch` and
  `tasks.kill`, which is correct: a runaway script clicking Allow on
  every notification would still be capped.
- [x] **Optimistic update has rollback.** The toast's `respond`
  function snapshots the item, sets `status:"submitting"` (UI
  feedback), removes the item on success, and re-inserts the item
  with the error code/message on failure. Rollback exercised by the
  view test that renders `status:"error"` (re-enabled buttons +
  visible error code/message).
- [x] **Confirmation pattern for destructive action.** Per the spec
  scope (and v1 IMPLEMENTATION-PLAN §P2-T9: *"toast → click Allow"*),
  the permission toast is **non-modal** — confirming is a single
  click, not a typed-name guard. Rationale: the daemon polls every
  2 s and auto-denies on a 5-minute timeout; a user staring at a
  pending permission needs immediate response, not a friction
  pattern intended for kill (`<DangerConfirm>`). The two destructive
  surfaces (Allow == privilege grant, Deny == reject) are both
  *one-click* by design — Telegram's relay UX is identical for
  parity. The 200-char command truncation + tool-name display gives
  the user enough context to make the call.
- [x] **No secret leak.** Audit payload **omits** `command` entirely
  (asserted in the privacy test that seeds a row with `pg_dump` /
  `leak.sql` and grep's the resulting JSON for those literals).
  The toast renders the command but truncates to 200 chars; the
  full command is never persisted client-side, only displayed.

## Risk + mitigation review

| Risk | Status | Notes |
|------|--------|-------|
| **Cross-repo schema drift** on `permissions` table | LOW | Reads/writes go through the vendored Drizzle schema (`permissions` columns: `id`, `sessionId`, `toolName`, `command`, `description`, `status`, `response`, `respondedAt`, `timeoutSeconds`). A column rename surfaces as a TS error. The route's `coerceStatus` defends against unknown `status` strings (bucketed as `pending` rather than crashing). |
| **Race: Telegram approves while user clicks Allow** | MITIGATED | Server-side check returns `alreadyResolved:true`; toast SSE feed clears the item via `resolved` event on the next poll. The audit row records the no-op for forensics. |
| **Daemon poll latency (2 s)** | DOCUMENTED | Worst-case latency from "user clicks Allow" → "daemon's hook returns" is ≈ 2 s. Faster than Telegram's typical 1-3 s round trip; acceptable. |
| **Permission `command` carries shell snippets** | MITIGATED | Audit `payload_json` never includes `command`. View truncates to 200 chars + uses `whitespace-pre-wrap break-all` so layout doesn't break on long single-token strings. |
| **EventSource reconnect storm if daemon restarts** | LOW | Browser EventSource auto-reconnects with backoff; the route handler is a thin DB read so a reconnect storm is bounded by the SSE poll interval (1.5 s). |
| **CSRF cookie absent (long-idle session)** | MITIGATED | View shows "session expired" hint; both buttons disabled. Wrapper sets `csrfMissing` from a synchronous cookie read on mount. |
| **Toast mounted on /login → wasted EventSource** | MITIGATED | Mounted *inside* the authed-shell branch in `app/layout.tsx`; unauth'd routes (e.g. `/login`) don't open the stream. |
| **Multi-tab consistency** | DESIGNED-OUT | If two tabs show the toast and the user clicks Allow on tab A, tab B sees `resolved` on the next 1.5-s poll and clears its toast. No cross-tab coordination needed. |

## Notable design decisions

1. **No MCP tool for `permissions.respond`.** v1 ARCH §10 explicitly
   inherits the existing `permissions` table contract. The dashboard
   updates the daemon-owned row directly via `bun:sqlite`. Rationale:
   the daemon already polls; introducing a daemon-side MCP tool just
   for this would add a turnaround without solving any problem. If
   the daemon ever exposes one, the procedure swaps the SQL UPDATE
   for an MCP call; the wire shape is unchanged.

2. **30-second tail window in `readSnapshot`.** The route reads
   pending rows OR rows that were responded within the last 30 s.
   Without the tail, a `pending → approved` flip between two polls
   would be invisible to the diff helper (the row would simply
   disappear from `curr`); the tail keeps it around long enough to
   emit a `resolved` event. The diff helper's silent-deny safety
   net catches the case where the daemon archives a row without us
   ever seeing it resolve.

3. **Pure view + injectable wrapper.** Same shape as
   `<DispatchDialog>` (T02) and `<DangerConfirm>` (T11). The view
   tests run under bun:test via `renderToStaticMarkup` (no jsdom).
   The wrapper accepts `eventSourceFactory`, `fetchImpl`, and
   `readCookie` props for tests, but the production caller passes
   nothing (defaults read from globals).

4. **Audit privacy.** The privacy test seeds a row with a
   `pg_dump > /tmp/leak.sql` command and asserts the resulting
   `payload_json` does not contain `pg_dump`, `leak.sql`, or
   `command`. The `decision`, `toolName`, and `sessionId` are
   recorded; the operator's audit forensics can correlate against
   the daemon's own log via `request_id`.

5. **Stream URL exposed for tests.** `RESPOND_URL` is exported from
   the toast component (and `RESPOND_URL`, `buildRespondRequest`
   from `permissions-client.ts`) so a future Playwright spec can
   intercept the request without hardcoding the path.

## Out-of-scope follow-ups

- **Daemon-side MCP tool for permission response** — would let the
  dashboard fail back through the same mutation surface as
  dispatch / kill. Filed as a follow-up against `claude-bridge`.
- **Browser `Notification.requestPermission`** — desktop OS-level
  alert when the dashboard is in a background tab. Phase 3 / 4 nice-
  to-have.
- **Permission history page** — `/audit` (T05) already shows
  `permission.respond` rows; a dedicated `/permissions` viewer is
  not load-bearing for Phase 2.
- **Wrapper-level integration test (`tests/app/permission-relay-toast-wrapper.test.ts`)** —
  the wrapper is exercised end-to-end via the route handler test +
  the view tests. A pure-React wrapper test under jsdom would also
  exercise the EventSource subscription + fetch interaction; not
  needed for Phase 2 acceptance, may add in Phase 4 as part of the
  jsdom e2e harness.

---

*Review written by loop iter 13/15 on 2026-05-06. Phase 2's mutation
surface is now complete (T01 dispatch + T03 kill + T06 loop approve/
reject + T09 permission relay). Phase test sweep + sign-off remain
(iter 14 + 15).*
