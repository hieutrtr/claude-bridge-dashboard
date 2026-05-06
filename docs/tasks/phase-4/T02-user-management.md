# T02 — User management page (`/settings/users`)

> **Phase:** 4 (Polish & Multi-user) · **Iter:** 3/16 · **Status:** done · **Risk:** Low · **Depends:** T01 magic-link auth (users table + envOwnerUser identity)

## Goal

Land the owner-facing surface for managing the dashboard's user roster.
With T01 the `users` table exists but only the env-owner + magic-link
consume route can write to it; T02 adds the owner-only invite / revoke
/ change-role flows so a real team can be onboarded by an admin
without shelling into SQLite.

## Surface delivered

### tRPC `users.*` router (`src/server/routers/users.ts`)

| procedure          | shape                                          | notes                                                            |
|--------------------|------------------------------------------------|------------------------------------------------------------------|
| `users.list`       | Query → `UserListRow[]`                        | Owner-only. Active rows (revoked filtered out). Sort: owners first, then by `last_login_at DESC` then `created_at DESC`. No audit row (queries are not audited per Phase 2/3 invariant). |
| `users.invite`     | Mutation → `UserMutationResult`                | Owner-only. Idempotent: existing active row returns `alreadyExisted:true` (no-op, audit logged); revoked row is re-activated and returns `reactivated:true`. New rows created via `findOrCreateUser` (re-uses T01's race-safe upsert). |
| `users.revoke`     | Mutation → `UserMutationResult`                | Owner-only. Soft-deletes via `revoked_at = now`. **Self-revoke blocked** (`BAD_REQUEST` + audit `user.revoke.error code=self_revoke_blocked`). Idempotent on already-revoked target. |
| `users.changeRole` | Mutation → `UserMutationResult`                | Owner-only. **Last-owner gate** (`COUNT(*) WHERE role='owner' AND revoked_at IS NULL <= 1`) blocks demoting self or any sole owner. Same-role no-op returns `alreadyApplied:true`. Refuses revoked targets. |

Inline RBAC guard: every procedure runs `requireOwner(ctx, route)` first.
The guard:

1. `UNAUTHORIZED` for missing `ctx.userId`.
2. `UNAUTHORIZED` for an unknown sub (DB lookup miss).
3. `UNAUTHORIZED` for a revoked user (matches T01 `resolveSessionUser`).
4. `FORBIDDEN` for `role:member`.

Each rejection writes an `audit_log` row with action `rbac_denied`,
`resource_type` = the requested route (e.g. `users.invite`), and a
payload `{ requiredRole, callerRole }`. T03 generalises this into a
tRPC middleware; the inline guard keeps the row shape identical so
T03's matrix tests continue to pass against existing audit data.

### Frontend

- `app/settings/users/page.tsx` — server component. Reads the session
  cookie via `next/headers cookies()`, resolves `auth.me`, branches:
  - signed-out → minimal banner (middleware also redirects to /login)
  - member → "Owner access required" amber banner with a CTA
  - owner → renders `<UsersTable>` with the active list.
- `src/components/users-table.tsx` — client component. Owns the
  invite modal state, inline role-select dropdown, and revoke flow:
  - Invite modal accepts `email` + `role` radio (member|owner). Uses
    `<form onSubmit>` with `e.preventDefault()` so submit-on-enter
    works without a button click. Surface the server error verbatim
    (RBAC, validation).
  - Inline role select: server-confirmed (no optimistic UI). Disabled
    when the row is mid-flight or it's the last owner.
  - Revoke wrapped in `<DangerConfirm verb="Revoke" expectedConfirmation={u.email}>`
    — the user must type the target's email to enable the button,
    matching the kill/cancel pattern from Phase 2.
  - Self-row shows a "you" pill and the revoke column shows
    "cannot revoke self" rather than the button.
- `src/lib/users-client.ts` — pure browser helpers: `buildInviteRequest`,
  `buildRevokeRequest`, `buildChangeRoleRequest`, `parseTrpcResponse`,
  `isValidEmail`. No DOM imports; mirrors `schedule-action-client.ts`
  shape so the test surface is plain bun:test (no jsdom).

### Nav

- `src/lib/nav.ts` — appends `{ label: "Users", href: "/settings/users" }`.
  The link renders for all signed-in users for discoverability; non-
  owners see the "Owner access required" banner on the page itself.

## Test surface

| File                                                  | Tests | Focus                                                                                    |
|-------------------------------------------------------|-------|------------------------------------------------------------------------------------------|
| `tests/server/users-router.test.ts` (new)             | 26    | RBAC entrance grid (anon / unknown sub / member / revoked owner / env-owner); list sort; invite (new / idempotent / re-activate / member denial); revoke (happy / self-block / NOT_FOUND / idempotent / member denial); changeRole (promote / demote / last-owner self-demote / last-owner with revoked-second-owner / no-op / NOT_FOUND / revoked target / member denial); audit privacy invariant (plaintext email never leaks across the full multi-mutation timeline). |
| `tests/lib/users-client.test.ts` (new)                | 15    | Three request builders emit `POST` + CSRF header + JSON body; `parseTrpcResponse` envelope variants; `UsersMutationError` thrown with code+message; `isValidEmail` table (valid / invalid / length cap). |
| `tests/lib/nav.test.ts` (extended)                    | +0    | Updated to expect 7 entries with `Users` last; existing `isNavActive` cases unchanged.   |

Bun test summary after T02: `1062 pass / 0 fail / 5849 expect() calls`.

## Phase 4 invariant checklist

- [x] **CSRF guard:** every mutation lands on `/api/trpc/users.<x>` so
      the global tRPC route handler runs `csrfGuard` before the router
      sees the request. Unit tests run via `appRouter.createCaller`
      which bypasses the route guard — CSRF is verified end-to-end by
      Phase 2's existing `csrf-guard.test.ts` over the shared route
      handler.
- [x] **Rate limit:** existing 30/min/user mutation bucket
      (`rate-limit-mutations.ts`) covers all three users.* mutations.
      No dedicated bucket — invite/revoke/changeRole are owner-only
      and the abuse surface is the magic-link request endpoint, not
      this page.
- [x] **`appendAudit`:** new actions `user.invite`, `user.revoke`,
      `user.role-change` (success); `user.invite` carries
      `alreadyExisted` / `reactivated` flags. Failure variants:
      `user.revoke.error` (code = `self_revoke_blocked` | `NOT_FOUND`),
      `user.role-change.error` (code = `last_owner` | `NOT_FOUND` |
      `user_revoked`). RBAC denials write `rbac_denied` with
      `resource_type` = the requested route. Payload includes
      `targetUserId` + `targetEmailHash` (never the plaintext email)
      and the role transition fields where applicable.
- [x] **No optimistic UI:** role select waits for the server response
      before flipping; revoke renders the success state from the
      `<DangerConfirm>` "success" copy. Matches the safety-over-
      snappiness rule in INDEX §3.
- [x] **DangerConfirm:** revoke wraps in `<DangerConfirm verb="Revoke"
      expectedConfirmation={u.email}>`. The user types the email to
      arm the button; the dialog re-uses the existing CSRF cookie
      check from Phase 2.
- [x] **RBAC (T03 preview):** inline `requireOwner` matches the audit
      shape T03 will emit from its centralised middleware — the
      `rbac_denied` row schema is the contract.
- [x] **Privacy:** every audit payload encodes `targetEmailHash` (never
      the email plaintext). Test `audit invariants (privacy)` runs the
      full mutation timeline (invite + changeRole + revoke) and asserts
      no plaintext email appears in any audit `payload_json`.

## Files touched

```
M src/lib/nav.ts
M src/server/routers/_app.ts
M tests/lib/nav.test.ts

A app/settings/users/page.tsx
A docs/tasks/phase-4/T02-review.md
A docs/tasks/phase-4/T02-user-management.md
A src/components/users-table.tsx
A src/lib/users-client.ts
A src/server/routers/users.ts
A tests/lib/users-client.test.ts
A tests/server/users-router.test.ts
```

## Verification

```bash
bun run typecheck    # green
bun run test         # 1062 pass / 0 fail
bun run build        # green; /settings/users in route table at 3.82 kB
```

New route in the build manifest:

```
ƒ /settings/users                      3.82 kB         115 kB
```

## Acceptance (from INDEX)

- [x] Owner can invite N users — exercised by the `users.invite` test
      grid (new / re-activate / idempotent / role=owner request).
- [x] Member visiting `/users` gets 403 — `users.list` RBAC test
      throws `FORBIDDEN`; the page renders the "Owner access required"
      banner with `data-role="forbidden-banner"` for E2E hooks.
- [x] Revoking self is blocked — `users.revoke` BAD_REQUEST test +
      UI disables the revoke control on the self-row.
- [x] Demoting last owner is blocked — `users.changeRole` last-owner
      test + UI disables the role select when only one active owner
      remains.
- [x] Audit log shows correct rows — every mutation writes one of
      `user.invite` / `user.revoke` / `user.role-change` (success) or
      the `.error` variant; `rbac_denied` rows for member/anon
      attempts.
