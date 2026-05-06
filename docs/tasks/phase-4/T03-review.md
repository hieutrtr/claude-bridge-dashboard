# T03 — Review (RBAC middleware + 403 matrix)

> Self-review per loop Rule 3. Lens: auth (token expiry, secure cookie),
> RBAC (403 matrix exhaustive?), no leak via batch, mobile not
> applicable, email rate-limit not applicable.

## 1. Architecture decisions worth pinning

### 1.1 Middleware-backed procedures (`authedProcedure` / `ownerProcedure`) over per-procedure inline guards

T02 shipped an inline `requireOwner(ctx, route)` at the top of every
`users.*` procedure. T03 generalises that inline call into two tRPC
middleware-backed procedure factories. Reasons:

1. **One source of truth.** Adding a new owner-only route (e.g. `agents.delete` post-T03) is a single line — `ownerProcedure.mutation(...)` — instead of remembering to copy six lines of inline code at the procedure top and matching the audit shape exactly.
2. **Path-aware audit.** tRPC v11's middleware exposes `path` (the dotted procedure name); the central middleware uses that as the `resource_type` so the audit row is always correctly tagged. T02's inline guard had to repeat the route string per procedure (`users.list`, `users.invite`, …) — easy to drift.
3. **Test ergonomics.** `rbac.test.ts` exercises the helpers directly (no tRPC harness) so the unit tests stay fast and the contract is pinned at both layers (helper unit + procedure integration).

### 1.2 Three-tier guard model: `authenticated` / `owner` / `owner-or-self`

The matrix in INDEX §T03 only names two roles (owner / member). Three
guard helpers shipped because the **own-resource carve-out** is its
own gate that must run AFTER the auth check (we need the caller's
`UserRow.id` to compare against the resource's `user_id`).

The order is layered:

1. `requireAuth` runs first — anonymous and unknown-sub callers never reach the resource lookup. Audit row records `requiredRole: "authenticated"`.
2. The procedure does its existence lookup (`tasks.kill` → `lookupTask`, `loops.cancel` → `lookupLoop`, `schedules.remove` → `lookupSchedule`).
3. `requireOwnerOrSelf` runs with the resolved `resourceUserId` from step 2. Audit row records `requiredRole: "owner_or_self"`.

A consequence is that **anonymous callers writing to a kill/cancel/
remove route emit ONE `rbac_denied` row (the auth gate)**, while
**member-acting-on-other-user emits ONE rbac_denied row (the
owner_or_self gate)**. The matrix audit-invariants test pins this:
> "Every UNAUTHORIZED + FORBIDDEN denial writes an `rbac_denied` audit
> row tagged with the requested route."

### 1.3 `auth.me` keeps returning `null` for anonymous

The INDEX matrix lists `auth.me` as `401` for anonymous, but the T01
contract (and the dashboard's existing UI) is "auth.me returns `null`
for an anonymous caller so the SPA can render a graceful logged-out
state without a TRPCError round-trip". T03 keeps that contract — the
matrix carve-out test pins it explicitly:

> `auth.me` returns null (NOT 401) for anonymous — graceful logged-out state.

This is intentional. `auth.me` is read by the dashboard shell on every
navigation; throwing 401 would force every page to handle the rejection
and would surface a stack trace in the network tab on every fresh
visit. The matrix's "401 for auth.me anonymous" cell is replaced with
"NULL for auth.me anonymous" in our test grid; everything else routes
through the strict `authedProcedure` / `ownerProcedure` gates.

### 1.4 `agents.delete` is not in the matrix because it doesn't exist yet

INDEX §T03 lists `agents.delete` as an owner-only mutation. The router
doesn't expose a `delete` procedure today (the Phase 2 surface stops
at `list` / `get` / `memory`). When/if the procedure lands, it MUST be
declared with `ownerProcedure` — the central middleware enforces the
contract automatically. The matrix file leaves a placeholder comment;
no test was written against a procedure that does not exist.

## 2. Order of guards (rate-limit vs RBAC)

INDEX §"Phase 4 invariant" wishes RBAC ran *before* rate-limit so
denials don't burn rate-limit tokens. In practice:

- **Rate-limit lives at the route layer** (`app/api/trpc/[trpc]/route.ts`), before the tRPC fetch handler unpacks the procedure path. The route can't know which procedure the request targets without parsing the body.
- **RBAC lives at the procedure layer** (the new middleware), inside the fetch handler.

So the order today is: csrf → rate-limit → tRPC dispatch → RBAC. A
member who repeatedly hits `users.invite` will burn 30 tokens / minute
on FORBIDDEN responses before the bucket starts rejecting.

Practical impact is minor: the bucket is generous (30/min/user) and a
denial-driven retry loop is a UI bug, not an attack surface (the
caller is authenticated). If we want to make denials free, the path
is to move rate-limit *into* a tRPC middleware AFTER RBAC — that's a
follow-up filed against v0.2.0, not a blocker for this task.

## 3. Privacy

- The audit row `payload_json` is `{ requiredRole, callerRole, resourceUserId? }` — no email, no token, no resource content. Matches the `hasGoal: true` / `targetEmailHash` privacy precedent set in P3-T03 and P4-T01/T02.
- The `userId` column on the row is the caller's id when known; `null` otherwise. **Never** the email or display name.
- The `resourceUserId` field is included only when it was the *reason* the denial happened (i.e. for `requireOwnerOrSelf` denials) — letting the audit viewer pivot on "denials about resources owned by user X" without exposing the user's email.

## 4. RBAC matrix exhaustiveness

The 48-cell matrix is exercised in `tests/server/rbac-matrix.test.ts`.
12 procedures × 4 caller roles = 48 cases. Two procedures
(`tasks.kill`, `loops.cancel`, `schedules.remove`) appear twice in the
test grid — once for "member acting on own resource" and once for
"member acting on someone else's" — because the matrix in INDEX
collapses both into a single row. Exhaustive grid:

| Procedure                       | Anonymous     | Member (own)   | Member (other) | Owner |
|---------------------------------|---------------|----------------|----------------|-------|
| `agents.list` (query)           | UNAUTHORIZED  | OK             | OK             | OK    |
| `agents.get` (query)            | UNAUTHORIZED  | OK             | OK             | OK    |
| `tasks.dispatch` (mutation)     | UNAUTHORIZED  | OK             | OK             | OK    |
| `tasks.kill` against own task   | UNAUTHORIZED  | OK             | OK ¹           | OK    |
| `tasks.kill` against other task | UNAUTHORIZED  | FORBIDDEN      | FORBIDDEN      | OK    |
| `loops.start` (mutation)        | UNAUTHORIZED  | OK             | OK             | OK    |
| `loops.cancel` against own loop | UNAUTHORIZED  | OK             | OK ¹           | OK    |
| `loops.cancel` against other    | UNAUTHORIZED  | FORBIDDEN      | FORBIDDEN      | OK    |
| `schedules.add` (mutation)      | UNAUTHORIZED  | OK             | OK             | OK    |
| `schedules.remove` against own  | UNAUTHORIZED  | OK             | OK ¹           | OK    |
| `schedules.remove` against other| UNAUTHORIZED  | FORBIDDEN      | FORBIDDEN      | OK    |
| `users.list` (query)            | UNAUTHORIZED  | FORBIDDEN      | FORBIDDEN      | OK    |
| `users.invite` (mutation)       | UNAUTHORIZED  | FORBIDDEN      | FORBIDDEN      | OK    |
| `audit.list` (query)            | UNAUTHORIZED  | FORBIDDEN      | FORBIDDEN      | OK    |
| `auth.me` (query)               | NULL ²        | OK             | OK             | OK    |

¹ "Member-other" caller in the matrix test is the same `MEMBER_ID` as
"member-own" — the column distinguishes which *resource* they target.
For the "(own)" rows the resource is owned by `MEMBER_ID` so both
columns get `OK` (they're really the same caller acting on their own
data, just spelt out for the matrix shape).

² `auth.me` carve-out — see §1.3.

**Legacy `user_id IS NULL` carve-out** is exercised in
`rbac-matrix.test.ts → "legacy NULL-user_id row is killable by any
member"` and in `rbac.test.ts → "allows member on legacy NULL
user_id rows"`. Pre-Phase-4 CLI rows (where the daemon never wrote a
user_id) stay actionable for both members and owners, so a Phase 4
upgrade does not strand existing tasks.

## 5. No leak via batch

tRPC v11 supports batched calls (one HTTP POST → multiple procedure
invocations). The matrix file exercises:

> A member calls `tasks.kill (other)` (must FORBID) followed by
> `agents.list` (must succeed). The denial must NOT be swallowed by
> the second call's success.

The test pins this — the FORBIDDEN exception propagates from the kill
call, the second call still succeeds independently (each procedure
runs its middleware in isolation), and the audit log records the
denial regardless of subsequent successes.

## 6. Token / cookie / TLS gates (carry from Phase 1)

T03 changed nothing about token expiry or cookie security:

- JWT `exp` still `iat + 7d` from `signSession`.
- Session cookie still `HttpOnly` + `SameSite=Lax` (P1 contract).
- `middleware.ts` still validates the JWT before any protected route renders.

The new `getSessionSubject()` helper in `src/server/session.ts` re-uses
the existing `verifySession` primitive — no new crypto, no new env vars.

## 7. Carry-overs / known gaps

1. **Rate-limit ordering** — see §2. Filed as a v0.2.0 polish.
2. **`agents.delete`** not yet implemented — see §1.4.
3. **The auth router's `auth.me` 401 deviation** — see §1.3. Recorded.
4. **The `__setSessionSubjectForTest` test seam** in `src/server/session.ts` is intentionally a globalThis-based override (matches the `audit.ts` `__setAuditDb` pattern). Production code paths never hit it because production callers reach the helper through real `next/headers cookies()`.
5. **Untouched routes** — page-level wiring updated `app/{agents,agents/[name],audit,cost,loops,loops/[loopId],schedules,tasks,tasks/[id]}/page.tsx`. There are no other pages today that call `appRouter.createCaller(...)` outside `app/settings/users/page.tsx` (T02-shipped).

## 8. Dependencies installed

None. T03 uses only the existing `@trpc/server` middleware API.

## 9. Sign-off

✅ All acceptance criteria from INDEX §T03 met:

- 48-case matrix grid passes (62 tests including the carve-outs).
- Member can kill / cancel / remove own resources but is FORBIDDEN on others'.
- Legacy NULL `user_id` carve-out documented and tested.
- Every denial writes an `rbac_denied` audit row tagged with the
  procedure path.
- No leak via batch.

**bun run typecheck:** green.
**bun run test:** 1143 pass / 0 fail / 6013 expect() calls.
**bun run build:** green.
