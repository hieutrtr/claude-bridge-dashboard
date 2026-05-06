# P2-T09 — Permission relay UI

> When the daemon's `PreToolUse` hook fires for a guarded command (Bash,
> Edit, …), it inserts a row into the `permissions` table and busy-polls
> the row for an `approved` / `denied` status (`src/infra/permissions.ts`
> in the claude-bridge daemon repo). Today the only approval surface is
> Telegram. T09 adds a dashboard surface: a real-time toast that pops
> while the user is at the dashboard, with Allow / Deny buttons that
> resolve the pending row in well under the daemon's 5-minute poll
> deadline.
>
> Highest-risk Phase 2 task per `docs/PHASE-2-REVIEW.md` — the
> `permissions` table schema and the daemon's poll-based protocol are
> daemon-owned; we are *consuming* a contract we do not control. The
> task is sequenced **last** of the 12 (slot 13/15) precisely so a
> contract-drift surprise can be quarantined to this task without
> blocking the rest of Phase 2 from shipping.

## References

- v1 IMPLEMENTATION-PLAN P2-T9 — *"Khi Claude Code yêu cầu permission
  (Bash, Edit), dashboard show notification + Allow/Deny button thay
  vì phải qua Telegram. Acceptance: tool_use_pending event qua SSE →
  toast → click Allow → relay xong < 1s. Risk: cao — phụ thuộc cấu
  trúc permission relay hiện hữu (`src/infra/permissions.ts`)."*
- v1 ARCH §5 — channel-multiplexed SSE; T09 reuses the
  `createTaskStreamResponse` shape from Phase 1 T08 but emits a
  different event vocabulary (`pending` / `resolved`) over a separate
  endpoint to keep the existing `/api/stream/tasks` consumers
  untouched.
- v1 ARCH §10 — *"Approve/reject permission qua dashboard cũng đi
  qua existing `permissions` table — kế thừa security model hiện
  hữu."* This is the load-bearing decision: the dashboard does
  **not** call a daemon MCP tool to resolve a permission. It writes
  the response straight into the `permissions` row, which the daemon
  is already polling. The audit row covers our side of the
  transaction.
- INDEX (this phase) §"Iteration mapping" — slot 13. *"Highest risk
  last; failure here doesn't block other tasks."*
- `src/db/schema.ts` lines 68-82 — `permissions` Drizzle table:
  `id`, `sessionId`, `toolName`, `command`, `description`, `status`
  (`pending` | `approved` | `denied`), `response`, `createdAt`,
  `respondedAt`, `timeoutSeconds`.
- `src/infra/permissions.ts` (claude-bridge daemon repo) lines
  47-60 — the daemon polls `db.getPermission(requestId)` on a 2-s
  cadence; an `approved` / `denied` status flip is sufficient to
  unblock the hook. No MCP signal needed.
- `src/server/sse-tasks.ts` + `src/lib/sse.ts` — Phase 1 SSE
  scaffolding we copy structurally (poll cadence, snapshot diff,
  heartbeat, abort handling).
- `src/server/audit.ts` — every Allow / Deny writes one
  `permission.respond` audit row with `payload = { decision,
  toolName, sessionId }`. Daemon-side audit, when it lands, joins
  on the dashboard's `request_id`.

## Scope

### Server side

- New pure helper `src/lib/permissions-stream.ts`:
  - `PermissionSnapshot` type (id, sessionId, toolName, command,
    description, status, createdAt, timeoutSeconds).
  - `diffPermissionSnapshots(prev, curr)` returns `{ pendingEvents,
    resolvedEvents, nextSnapshot }`. A row is a "pending event" when
    it is new and `status === "pending"`; a row is a "resolved
    event" when its status flipped from `pending` to `approved` or
    `denied`. Rows that disappear from the poll (deleted /
    archived) emit a `resolved` event with `status="denied"` as a
    safety default — the daemon would have already moved on by
    then, but the toast must clear itself.
  - IO-free; no SQLite import; pure helper testable under bun:test.
- New SSE response factory `src/server/sse-permissions.ts`:
  - Mirrors `createTaskStreamResponse` shape: `signal`, `pollMs`,
    `heartbeatMs`, `readSnapshot`. Emits `init`, `pending`,
    `resolved` events.
  - `init` payload: `{ permissions: PermissionSnapshot[] }` — the
    full set of `status='pending'` rows at connect time.
  - `pending` payload: one event per new pending row (`{ id, … }`).
  - `resolved` payload: one event per row that flipped (`{ id,
    status }`).
  - Heartbeat comment cadence identical to `/api/stream/tasks` so a
    proxy that idle-times one stream times out the other.
- New route `app/api/stream/permissions/route.ts`:
  - `GET` only. Auth gating piggy-backs on `middleware.ts` (already
    behind the JWT cookie); the route does **not** write.
  - `readSnapshot` queries `permissions` where `status='pending'`
    OR (`status IN ('approved','denied')` AND `respondedAt`
    within the last 30 seconds). The 30-second tail lets the
    diff helper detect status flips on rows the previous tick saw.
- New tRPC router `src/server/routers/permissions.ts`:
  - `respond({ id, decision: "approved"|"denied" })` mutation.
    `id` is a string (the daemon stores `permissions.id` as text
    — the requestId is `crypto.randomUUID().slice(0,8)`).
  - Looks up the row; throws `NOT_FOUND` for unknown id; returns
    `{ ok: true, alreadyResolved: true }` when the row is no
    longer `pending` (race: Telegram beat us).
  - Updates the row: `status = decision`, `response = decision`,
    `respondedAt = CURRENT_TIMESTAMP`. Single SQL `UPDATE` — the
    daemon polls; no MCP call.
  - Audit on every path: `permission.respond` (success),
    `permission.respond` with `alreadyResolved:true` (race),
    `permission.respond.error` on DB error. `payload` includes
    `decision`, `toolName`, `sessionId`. **Never** echoes
    `command` (may carry user-private shell text).
- Wire into `appRouter` (`src/server/routers/_app.ts`).

### Client side

- New pure helper `src/lib/permissions-client.ts`:
  - `RESPOND_URL` constant.
  - `RespondInput` / `RespondResult` wire types.
  - `buildRespondRequest({ id, decision }, csrfToken)` →
    `{ url, init }` — same wire shape as
    `buildKillTaskRequest`.
  - Re-exports `parseTrpcResponse`, `readCsrfTokenFromCookie`,
    `DispatchError` from `dispatch-client.ts`.
- New view component `<PermissionRelayToastView>` (pure props):
  - `open: boolean, items: PermissionToastItem[]` — only renders
    when `items.length > 0`.
  - Each item shows tool name, command (truncated to 200 chars),
    Allow / Deny buttons. The buttons disable while
    `status === "submitting"` for that item, and on
    `csrfMissing === true`.
  - Accessibility: `role="status"` on the wrapper, `role="alert"`
    when a new item arrives (the wrapper component flips this).
- New wrapper `<PermissionRelayToast>` (`"use client"`):
  - Mounts an `EventSource("/api/stream/permissions")`. On `init`,
    seeds the local list. On `pending`, appends. On `resolved`,
    removes the item. On `error`, retries after 5 s (mirrors the
    EventSource browser behaviour but explicit so we can test it).
  - Allow / Deny: reads `document.cookie` for CSRF, calls
    `buildRespondRequest`, optimistically removes the item, rolls
    back on error.
  - Mounted in `app/layout.tsx` next to `<DispatchDialog>`.
- Pure helpers tested under bun:test; the wrapper relies on browser
  globals so we ship a *jsdom-free* shape: an `eventSource` factory
  prop that defaults to `() => new EventSource(url)` is injected so
  the wrapper can be exercised under bun:test with a stub.

## Acceptance criteria

1. **Pure SSE helper.** `diffPermissionSnapshots`:
   - Returns no events on identical snapshots.
   - Emits `pending` for any row not seen in `prev`.
   - Emits `resolved` for any row whose status flipped from
     `pending` to `approved` / `denied`.
   - Emits `resolved{status:"denied"}` for any row in `prev` whose
     id is **not** in `curr` (treat as silently denied — defensive).
   - Computes `nextSnapshot` correctly so consecutive ticks
     converge to no-op when nothing changes.
2. **SSE response factory.** `createPermissionStreamResponse`:
   - Returns a `Response` with the same SSE headers as
     `createTaskStreamResponse` (`Content-Type: text/event-stream`,
     `Cache-Control: no-cache, no-transform`,
     `X-Accel-Buffering: no`).
   - Emits `init` immediately on connect with the initial snapshot.
   - Emits `pending` events for new rows on subsequent polls.
   - Emits `resolved` events for status flips on subsequent polls.
   - Heartbeat comment fires on `heartbeatMs`.
   - Aborts cleanly when `signal.abort()` fires (same pattern as
     T08 sse-tasks).
3. **Route handler.** `app/api/stream/permissions/route.ts`:
   - `GET` returns the SSE response.
   - `readSnapshot` queries the `permissions` table once per poll;
     no transaction needed (read-only).
   - Honours `SSE_PERMISSIONS_POLL_MS` (default 1500 ms) and
     `SSE_PERMISSIONS_HEARTBEAT_MS` (default 15 000 ms).
4. **tRPC `permissions.respond`.**
   - Input: `{ id: string (1..32), decision: "approved"|"denied" }`.
     Trims and rejects any other `decision` value via Zod enum.
   - **Server-side race check.** When the row already has a
     non-`pending` status, return `{ ok: true, alreadyResolved:
     true }` and write a `permission.respond` audit row with
     `alreadyResolved:true` — no UPDATE issued.
   - **Happy path.** Updates `status`, `response`, `respondedAt`
     in a single `UPDATE`. Returns `{ ok: true,
     alreadyResolved: false }`.
   - **Unknown id.** Throws `NOT_FOUND`.
   - **DB error.** Wraps in TRPCError `INTERNAL_SERVER_ERROR`,
     writes `permission.respond.error` audit.
   - Audit payload **never** includes the `command` text — it
     contains `decision`, `toolName`, `sessionId`, and the race
     flags.
5. **Pure client helper.** `permissions-client.ts`:
   - `RESPOND_URL === "/api/trpc/permissions.respond"`.
   - `buildRespondRequest({ id: "abc", decision: "approved" },
     "csrf-x")` returns the standard tRPC POST envelope with the
     `x-csrf-token` header.
   - Helper does not depend on `document` or `window`.
6. **`<PermissionRelayToastView>` (pure props).**
   - `items.length === 0` → renders nothing observable.
   - One item → renders the tool name + truncated command + Allow
     + Deny buttons.
   - Multiple items → renders a stack (the most recent at the top).
   - `csrfMissing=true` → both buttons disabled, hint visible.
   - Per-item `status="submitting"` disables that item's buttons
     but **not** other items' buttons.
   - `status="error"` → renders the per-item error code + message
     and re-enables buttons so the user can retry.
7. **`<PermissionRelayToast>` (interactive wrapper).**
   - Subscribes to `/api/stream/permissions` on mount via the
     injectable `eventSource` factory.
   - `init` seeds the list; `pending` appends; `resolved`
     removes by id.
   - Allow / Deny: optimistically removes the item before the
     fetch resolves; on error, re-inserts the item with the error
     state.
   - Closes the EventSource on unmount.
8. **Layout wiring.** `app/layout.tsx` mounts
   `<PermissionRelayToast>` inside the authed-shell branch, next to
   the existing `<DispatchDialog>`. The mount is server-component
   friendly (the toast file is `"use client"`).
9. **No mutation bypass.** The Allow / Deny buttons call the same
   tRPC POST that ships in this task — CSRF + rate-limit
   middleware (T07/T08) gate it. The button does not read the DB,
   does not call the daemon, does not write `audit_log` directly.
10. **No regression.** The full `bun test` suite stays green.
    `bun run typecheck` clean. `bun run build` clean. The
    `/api/stream/tasks` endpoint and its consumers are untouched.

## Non-goals

- **Daemon-side MCP tool for permissions.** v1 ARCH §10 explicitly
  inherits the existing `permissions` table contract; we do not
  introduce a new `bridge_permission_respond` MCP tool in this
  task. If the daemon adds one later, the tRPC procedure swaps
  the `UPDATE` for an MCP call without changing the wire shape.
- **Permission history page.** A `/permissions` viewer (read-side
  log of past approvals) is out of scope. Audit log
  (`/audit`, T05) already shows `permission.respond` rows.
- **Push notifications.** Browser-level `Notification.requestPermission`
  is out of scope; the toast is a foreground UI surface.
- **Multi-tab consistency.** If two browser tabs both show the
  toast and the user clicks Allow on tab A, tab B will see the
  `resolved` event on the next poll and clear its toast.
  No cross-tab coordination needed.
- **Suspended permissions / batch approve.** Each toast is
  per-permission; no "approve all of this tool" UI.
- **Optimistic re-pending.** If the daemon re-issues a permission
  with the same id (it does not in current implementation), we
  treat it as a new pending row. No special-case logic.

## TDD plan (RED → GREEN)

### File 1: `tests/lib/permissions-stream.test.ts`

Pure diff-helper tests:

1. Identical snapshots → `{ pendingEvents: [], resolvedEvents: [] }`.
2. New pending row → one `pendingEvents` entry, zero `resolvedEvents`.
3. Existing pending row unchanged → no events.
4. Status flips `pending → approved` → one `resolvedEvents` with
   `status="approved"`.
5. Status flips `pending → denied` → one `resolvedEvents` with
   `status="denied"`.
6. Row disappears from snapshot → one `resolvedEvents` with
   `status="denied"` (silent-deny default).
7. Multiple rows changing in one tick → events match each change.
8. `nextSnapshot` is a `Map` keyed by id with the *current* row
   values, not the prev ones.

### File 2: `tests/server/sse-permissions.test.ts`

Mirrors `tests/server/sse-tasks.test.ts`:

1. Returns a `Response` with SSE headers (Content-Type, Cache-
   Control, X-Accel-Buffering).
2. Emits `init` with the initial snapshot.
3. Emits `pending` when a new row appears on the second poll.
4. Emits `resolved` when a row's status flips to `approved`.
5. Emits heartbeat comment on the heartbeat cadence.
6. Closes cleanly on `signal.abort()`.

### File 3: `tests/server/permissions-router.test.ts`

Mirrors `tests/server/loops-router.test.ts` (tmp on-disk DB +
`appRouter.createCaller`):

1. **Happy path approved.** Seed pending row → `respond({id,
   decision:"approved"})` → returns `{ ok:true,
   alreadyResolved:false }`; row's `status="approved"`,
   `response="approved"`, `respondedAt` non-null; one
   `permission.respond` audit row whose payload contains
   `decision:"approved"`, `toolName:"Bash"`, `sessionId:"sess-1"`,
   no `command` field.
2. **Happy path denied.** Same as 1 but `decision:"denied"`.
3. **Unknown id.** Throws `NOT_FOUND`; no audit row.
4. **Already resolved race.** Seed `status="approved"` row →
   `respond({id, decision:"denied"})` → returns `{ ok:true,
   alreadyResolved:true }`; row unchanged; audit row's payload
   has `alreadyResolved:true`.
5. **Decision validation.** `decision:"foo"` → Zod throws
   `BAD_REQUEST`; no audit row, no DB change.
6. **Audit excludes command text.** Seed row whose `command`
   contains `"rm -rf /"` → audit payload JSON does not contain
   `"rm -rf"` substring.

### File 4: `tests/lib/permissions-client.test.ts`

Pure helpers:

1. `RESPOND_URL` value.
2. `buildRespondRequest` URL + method.
3. Content-type + CSRF header.
4. Body wrapping `{ json: { id, decision } }`.
5. Decision values pass through verbatim.

### File 5: `tests/app/permission-relay-toast.test.ts`

`<PermissionRelayToastView>` view tests via
`renderToStaticMarkup`:

1. `items.length===0` → markup empty (no `role="status"` or
   matches an empty wrapper).
2. One pending item → tool name, command excerpt, Allow + Deny
   buttons rendered.
3. `csrfMissing=true` → buttons disabled, hint visible.
4. Item with `status="submitting"` → that item's buttons disabled.
5. Item with `status="error"` → error code + message rendered;
   buttons re-enabled.
6. Long command → truncated to ~200 chars with ellipsis.
7. Multiple items → stack of N rows.

### File 6: `tests/app/stream-permissions-route.test.ts`

Route handler smoke (mirrors
`tests/app/stream-tasks-route.test.ts`):

1. `GET` returns SSE response with correct Content-Type.
2. `init` event lands within ~100 ms.

### File 7 (optional): `tests/app/permission-relay-toast-wrapper.test.ts`

Driven via injected `eventSource` factory to assert:

1. `init` payload populates the visible item set.
2. `pending` appends.
3. `resolved` removes by id.
4. Allow click triggers a `fetch` to `RESPOND_URL` with the
   correct body.

## Risk + mitigation (from PHASE-2-REVIEW §c, §e.4)

| Risk | Mitigation |
|------|------------|
| **Cross-repo schema drift** — daemon renames `permissions.status` or removes it | T09 reads through the vendored Drizzle schema; a renamed column surfaces as a TS compile error in the next `bun run sync-schema`. The route's `readSnapshot` returns an empty list on read failure (no crash). |
| **Race: Telegram approves while user clicks Allow** | Server-side check + race-detect; user sees `alreadyResolved:true`; toast clears. |
| **Daemon polls every 2 s — a 1.5-s SSE poll is faster than the daemon's reaction** | The daemon's poll latency is acceptable; user sees the toast clear within ≈ 2 s after Allow. We document this as the relay's worst-case latency. |
| **Permission `command` may carry shell text we shouldn't echo to logs** | Audit payload omits `command` entirely. Toast renders `command` truncated to 200 chars. |
| **CSRF token absent** (long-idle session) | View shows hint; both buttons disabled. User must reload to refresh the cookie. |
| **EventSource reconnect storm** if daemon restarts | Browser EventSource auto-reconnects with backoff; the route handler is a thin DB read so a reconnect storm is bounded by the SSE poll interval. |
| **Rate-limit on rapid Allow clicks** | T07 mutation rate-limit (30/min/user) covers this; the toast disables the button while submitting so a single click can't double-fire. |
| **Mounted on every page load → wasted EventSource on `/login`** | The toast is mounted *inside* the authed shell branch in `app/layout.tsx`, so unauth'd routes don't open the stream. |

## Files touched

- `src/lib/permissions-stream.ts` — NEW
- `src/server/sse-permissions.ts` — NEW
- `app/api/stream/permissions/route.ts` — NEW
- `src/server/routers/permissions.ts` — NEW
- `src/server/routers/_app.ts` — wire in
- `src/lib/permissions-client.ts` — NEW
- `src/components/permission-relay-toast.tsx` — NEW
- `app/layout.tsx` — mount the toast inside authed shell
- `tests/lib/permissions-stream.test.ts` — NEW
- `tests/server/sse-permissions.test.ts` — NEW
- `tests/server/permissions-router.test.ts` — NEW
- `tests/lib/permissions-client.test.ts` — NEW
- `tests/app/permission-relay-toast.test.ts` — NEW
- `tests/app/stream-permissions-route.test.ts` — NEW

## Out-of-scope follow-ups

- Daemon-side MCP tool for permission response (so the dashboard can
  fail back through the same mutation surface as dispatch / kill).
- Browser `Notification.requestPermission` for desktop OS-level
  alerts when the dashboard is in a background tab.
- Permission history page.

---

*Spec written for loop iter 13/15 on 2026-05-06. T09 is the final
mutation-side task before the phase-test sweep + sign-off.*
