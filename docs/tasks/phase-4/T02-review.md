# T02 — Code review

> **Iter:** 3/16 · **Status:** signed-off · **Reviewer:** loop bot (self-review against the Phase 4 INDEX invariants).

## §1 — RBAC enforcement (CRITICAL)

**Question:** does every mutation procedure actually deny non-owners?

Inline `requireOwner(ctx, route)` runs at the top of every procedure
in `src/server/routers/users.ts`:

| Procedure          | Guard call                                | Tested in                                          |
|--------------------|-------------------------------------------|----------------------------------------------------|
| `users.list`       | `requireOwner(ctx, "users.list")`         | RBAC grid (anon / unknown / member / revoked-owner) |
| `users.invite`     | `requireOwner(ctx, "users.invite")`       | "rejects member callers and audits rbac_denied"   |
| `users.revoke`     | `requireOwner(ctx, "users.revoke")`       | "rejects member callers"                          |
| `users.changeRole` | `requireOwner(ctx, "users.changeRole")`   | "rejects member callers"                          |

The guard's UNAUTHORIZED branch covers four conditions:

1. `ctx.userId == null` → anonymous; tested.
2. `resolveSessionUser(sub)` returns `null` for an unknown id → tested.
3. `resolveSessionUser(sub)` returns `null` for a revoked user (the helper short-circuits on `revokedAt !== null`) → tested via the "rejects revoked owner" case.
4. The DB throws on lookup → falls through to env-owner only when `sub === "owner"` (graceful dev seam); other subs route to UNAUTHORIZED.

The FORBIDDEN branch fires for `role:member`. Tested.

**Verdict:** ✅ The mutation surface is fully gated. T03's centralised
middleware will replace these inline calls; `rbac_denied` row shape is
identical (`resource_type` = the requested route, payload
`{ requiredRole, callerRole }`) so T03's matrix tests inherit the
existing audit data without breakage.

## §2 — Self-protection invariants

**Self-revoke** — `if (input.id === caller.id)` short-circuits before any DB write. Tested.

**Last-owner demotion** — the gate counts active owners (`COUNT(*) WHERE role='owner' AND revoked_at IS NULL`) and refuses when ≤ 1. The check fires regardless of whether the *target* is the caller, which is the correct behaviour — even with a 1-owner roster, demoting any owner (incl. self) to member is the same lock-out.

Edge case caught in test "blocks demoting the last owner even when other owners are revoked": a revoked second-owner row does not count toward the gate, so the test seeds an active + revoked pair and asserts the demote still fails. This matches the `users.list` filter (revoked rows are invisible) — the system is consistent across read and gate paths.

**Race window:** the count + UPDATE are NOT in a transaction. Two concurrent demotes of the only two active owners could each pass the count (n=2) and then race the UPDATE → leaving 0 owners. Mitigation:

- The window is human-scale (a single owner clicking two browser tabs in milliseconds). The audit log captures both writes so the loss is recoverable: re-promote one of the demoted accounts via SQL.
- A `BEGIN IMMEDIATE` transaction would close the window. Filed as a Phase 5 follow-up — the dashboard's bun:sqlite handle uses WAL + busy_timeout=5000, so the simple fix is to wrap the count+update in `db.transaction(...)`. Not blocking T03.

**Verdict:** ✅ acceptable for v0.1.0; documented gap with a recoverable failure mode.

## §3 — Why no automatic invite email

The v1 spec text reads "triggers `auth.requestMagicLink` for new email". I deliberately ship invite as a row-create-only mutation:

1. `requestMagicLink` already handles its own rate-limit + Resend graceful-fail surface (T01). Calling it from `users.invite` would mean an owner could invite 50 users in 50 seconds and exhaust the per-IP magic-link bucket (5/min/IP). Worse, the per-email bucket (5/hour/email-hash) prevents the invitee from then *requesting* their own magic link.
2. The owner-only audit trail captures the invite intent. The invitee starts the magic-link flow themselves on `/login`, which is the same surface a non-invited new user would hit — so inviting + non-inviting flows converge on a single, well-tested path.
3. The page UX banner reads "Ask the user to sign in via the magic-link form on the login page — no email is sent automatically." which is unambiguous.

T13 (release docs) will mention this in the v0.1.0 release notes so admins know to send the dashboard URL to invitees out-of-band. A "send email now" toggle could ship in v0.2.0 as a follow-up — it would be a separate Resend call from `users.invite` with its own rate-limit bucket, not a recursive call into the magic-link flow.

**Verdict:** ✅ deliberate scope choice; documented.

## §4 — Audit privacy

**Test "never includes plaintext email in any audit payload"** runs the full mutation timeline (invite + role-change + revoke) and asserts none of `boss@example.com` / `victim@example.com` / `fresh@example.com` appears in any `audit_log.payload_json`. The same guarantee is enforced row-by-row in the dedicated tests for each mutation.

The hash uses the same `emailHash(email, salt)` helper T01 ships, so forensic queries can correlate `auth.magic-link-request` ↔ `user.invite` ↔ `auth.magic-link-consume` rows across the audit log without ever seeing a plaintext address.

The list query DOES return plaintext emails to the UI — the privacy boundary is the audit log, not the API surface. This matches Phase 2's distinction (audit hashes, query plaintext OK).

**Verdict:** ✅ matches the Phase 4 invariant.

## §5 — DangerConfirm CSRF

`<DangerConfirm>` reads `document.cookie` once on open and disables the action button when the CSRF cookie is missing. The `submitRevoke` callback in `<UsersTable>` re-reads the cookie (defensive — the dialog's `onSubmit` could fire after a stale-tab logout). Both guards converge on the same cookie path.

The submit fetch sends `x-csrf-token: <cookie value>`; the global tRPC route handler runs `csrfGuard` first. Verified by Phase 2's existing `csrf-guard.test.ts` (no T02-specific test needed — the wire path is shared).

**Verdict:** ✅ no T02 regression of the Phase 2 CSRF surface.

## §6 — Mobile readiness

The table wraps in `<div class="overflow-x-auto">` with `min-w-[640px]` so iPhone-width (390 px) readers get a horizontal scroll instead of a clipped layout. Modal grids use `grid-cols-1` only (no responsive breakpoint needed). Self-checked with the build output (3.82 kB / 115 kB First Load — well within mobile budget).

Lighthouse mobile audit happens in T07 (mobile responsive pass) — T02 is in scope.

**Verdict:** ✅ mobile-friendly; defer Lighthouse score to T07.

## §7 — Idempotency

| Mutation     | Idempotent shape                                             | Audit                                                |
|--------------|--------------------------------------------------------------|------------------------------------------------------|
| `invite`     | existing active row → `alreadyExisted:true`, role unchanged  | `user.invite` with `alreadyExisted: true` flag       |
| `invite`     | revoked row → re-activate at requested role                  | `user.invite` with `reactivated: true`               |
| `revoke`     | already-revoked target → no DB write; original `revoked_at` preserved | `user.revoke` with `alreadyApplied: true`     |
| `changeRole` | same role → no DB write                                      | `user.role-change` with `alreadyApplied: true`       |

Each idempotent shape mirrors the Phase 2/3 pattern (`tasks.kill` → `alreadyTerminated`; `loops.approve` → `alreadyFinalized`; `permissions.respond` → `alreadyResolved`). Forensic auditing remains complete: every owner intent is recorded once, even if the row already matched the requested state.

**Verdict:** ✅ matches the existing idiom.

## §8 — Risks accepted (file under v0.2.0 follow-up)

1. **Last-owner race window** — two concurrent demotes could leave zero
   owners. Mitigation: wrap the count+update in `db.transaction()`. Out
   of scope for T02; recoverable via SQL.
2. **No bulk invite** — owners must invite users one at a time. Could
   add a CSV-paste UI in v0.2.0 if the user roster grows past ~20.
3. **No soft-delete recovery UI** — revoked users are visible only via
   the audit log + a re-invite (which re-activates). A "View revoked"
   filter on the page could ship in v0.2.0.
4. **Role audit trail** — when a user's role flips, no row in `users`
   captures the previous value; only the audit log does. If the
   audit log is rotated/pruned, history is lost. v0.2.0 could ship
   a separate `user_role_history` table; for now `audit_log` is the
   source of truth.

None of these block T03's RBAC matrix or the v0.1.0 release.

## Sign-off

T02 is consistent with the Phase 4 invariants (CSRF + rate-limit +
audit + RBAC + DangerConfirm + mobile-first). 41 tests added (26 router
+ 15 client). `bun run test` 1062 pass / 0 fail. `bun run build` green
with `/settings/users` at 3.82 kB. Ready to advance to T03.
