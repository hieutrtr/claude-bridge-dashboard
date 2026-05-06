# T03 — RBAC middleware (`role:owner` / `role:member`)

> **Phase:** 4 (Polish & Multi-user) · **Iter:** 4/16 · **Status:** done · **Risk:** Medium · **Depends:** T02 user management page (inline `requireOwner` shape was the contract this generalises)

## Goal

Replace T02's inline owner-only guard with a single, central RBAC
module + tRPC procedure middleware that gates every router uniformly.
Add the **owner-or-self** carve-out so members can dispatch / kill /
cancel / remove their *own* tasks / loops / schedules without any
audit-log gymnastics, while owners retain full access. Land the 48-cell
matrix grid that pins the contract for every (procedure × caller-role)
pair so a future drop-through is caught at unit-test time.

## Surface delivered

### `src/server/rbac.ts` — pure helpers

| Export                  | Behaviour                                                              |
|-------------------------|------------------------------------------------------------------------|
| `resolveCaller(ctx)`    | Pure resolver. Tagged role: `anonymous` / `unknown` / `member` / `owner`. Falls back to the synthetic `envOwnerUser()` when `sub === ENV_OWNER_USER_ID` AND the DB lookup misses (test seam without `BRIDGE_DB`). No throws, no audit writes. |
| `requireAuth(ctx, route)` | Throws `UNAUTHORIZED` for anonymous/unknown/revoked. Returns the resolved `UserRow`. Audits `rbac_denied` with `requiredRole: "authenticated"`. |
| `requireOwner(ctx, route)` | Throws `UNAUTHORIZED` for anon/unknown, `FORBIDDEN` for `member`. Audits `rbac_denied` with `requiredRole: "owner"`. |
| `requireOwnerOrSelf({ ctx, route, resourceUserId })` | Owner: always pass. Member: pass when `resourceUserId === caller.id` OR `resourceUserId === null` (legacy CLI carve-out). Else `FORBIDDEN` with `requiredRole: "owner_or_self"`. UNAUTHORIZED for anonymous (auth gate runs first). |

The audit row schema is **frozen** against T02's inline `requireOwner`
output (`{ requiredRole, callerRole, resourceUserId? }` payload, action
`rbac_denied`, `resource_type` = the requested route). Every existing
T02 audit-shape assertion in `users-router.test.ts` keeps passing
unchanged after the migration.

### `src/server/trpc.ts` — middleware-backed procedures

Two new exports next to `publicProcedure`:

| Export             | Use for                                                                              |
|--------------------|--------------------------------------------------------------------------------------|
| `authedProcedure`  | Read endpoints + mutations members may run (`tasks.dispatch`, `loops.start`, `schedules.add`, `permissions.respond`, every `*.list` / `*.get`). |
| `ownerProcedure`   | Owner-only routes (`users.*`, `audit.list`, future `agents.delete`).                |

Both middlewares hand the resolved `UserRow` onto `ctx.user` and pin
`ctx.userId` to the canonical id so downstream procedures don't have
to re-resolve. The middleware route name fed to `requireAuth`/
`requireOwner` is tRPC's own `path` (e.g. `users.invite`,
`tasks.kill`) so the audit row stays pivot-friendly.

`publicProcedure` is now used by exactly one router (`auth.*`) — see
the **carve-out** section below.

### Router migration

| Router        | Before              | After (T03)                                                  |
|---------------|---------------------|--------------------------------------------------------------|
| `agents`      | `publicProcedure`   | `authedProcedure` (all reads).                               |
| `analytics`   | `publicProcedure`   | `authedProcedure` (all reads).                               |
| `audit`       | `publicProcedure`   | `ownerProcedure` (audit log is owner-only — closes the Phase 2 deferral noted in `audit.ts` docstring). |
| `auth`        | `publicProcedure`   | unchanged — `auth.me` is the SPA's "are we logged in?" probe and must return `null` (not 401) for anonymous; `auth.logout` runs even for an already-cleared session. Carve-out documented in T03 review. |
| `loops`       | `publicProcedure`   | `authedProcedure` for every procedure; `start` is a plain authed mutation; `approve` / `reject` / `cancel` add `requireOwnerOrSelf` after `lookupLoop()` so members cannot finalise other people's loops. |
| `permissions` | `publicProcedure`   | `authedProcedure` (the Allow / Deny surface needs auth).     |
| `schedules`   | `publicProcedure`   | `authedProcedure` for every procedure; `pause` / `resume` / `remove` add `requireOwnerOrSelf` inside `makeScheduleActionProcedure` so members cannot pause/remove other people's schedules. |
| `tasks`       | `publicProcedure`   | `authedProcedure` for every procedure; `kill` adds `requireOwnerOrSelf` after the existence lookup so members cannot kill other people's tasks. |
| `users`       | `publicProcedure` + inline `requireOwner` | `ownerProcedure` (T02's inline guard removed). The procedure body keeps its own "cannot revoke yourself" / "cannot demote last owner" checks against `ctx.user`. |

Lookups for `tasks.kill`, `loops.{approve,reject,cancel}`, and
`schedules.{pause,resume,remove}` were extended to surface
`user_id` / `userId` so the carve-out check has the resource's
ownership without a second SELECT.

### Page-level wiring (Next.js App Router)

`middleware.ts` already redirects unauthenticated requests to `/login`
before any page renders, but the page server components were creating
the tRPC caller with an empty context (`createCaller({})`) so the new
RBAC middleware would have rejected them as anonymous. New helper:

* `src/server/session.ts` — `getSessionSubject()` reads the JWT from
  `next/headers cookies()` and returns `payload.sub` (or `null` when
  the cookie is missing / invalid). Includes a `__setSessionSubjectForTest`
  test seam (mirrors the audit-module pattern) so app tests can pin the
  caller's subject without standing up a real cookie store.

Pages updated to forward the subject onto the caller context:

* `app/agents/page.tsx`
* `app/agents/[name]/page.tsx`
* `app/audit/page.tsx`
* `app/cost/page.tsx`
* `app/loops/page.tsx`
* `app/loops/[loopId]/page.tsx`
* `app/schedules/page.tsx`
* `app/tasks/page.tsx`
* `app/tasks/[id]/page.tsx`

`app/settings/users/page.tsx` already had its own subject read (T02
shipped a pre-version of `getSessionSubject` inline) — left as-is so
the diff stays scoped to T03's surface.

## Test surface

| File                                                  | Tests | Focus                                                                                    |
|-------------------------------------------------------|-------|------------------------------------------------------------------------------------------|
| `tests/server/rbac.test.ts` (new)                     | 19    | Unit tests for `resolveCaller`, `requireAuth`, `requireOwner`, `requireOwnerOrSelf`. Covers env-owner / regular owner / member / unknown sub / revoked user / anonymous. Asserts `rbac_denied` audit shape. Includes the legacy `resourceUserId === null` carve-out. |
| `tests/server/rbac-matrix.test.ts` (new — **62 cases**) | 62    | The 48-cell 12-procedure × 4-role matrix (`agents.list/get`, `tasks.dispatch/kill[own,other]`, `loops.start/cancel[own,other]`, `schedules.add/remove[own,other]`, `users.list/invite`, `audit.list`) plus the `auth.me` carve-out trio plus an audit-invariant test that walks every denial cell and asserts (a) every UNAUTHORIZED+FORBIDDEN denial wrote an `rbac_denied` row tagged with the procedure path, (b) the legacy NULL `user_id` row is killable by members, (c) a denial in a multi-call session does NOT leak via batch. |

Existing tests touched (no behaviour change beyond carrying `userId`):

* `tests/server/{agents,analytics,audit,audit-router-perf,loops,schedules,tasks}-router.test.ts` — `appRouter.createCaller({})` → `appRouter.createCaller({ userId: "owner" })` so the procedure-level RBAC accepts the test caller. Each touched test file's coverage is unchanged; only the context shape is updated.
* `tests/server/dispatch-router.test.ts` + `kill-router.test.ts` + `loops-router.test.ts` + `schedules-router.test.ts` — the 5 pre-T03 tests that asserted "writes user_id=null when caller is unauthenticated" got rewritten to assert the new contract: **UNAUTHORIZED + audits `rbac_denied`** (and the daemon MCP is NOT called). Behaviour shifted from "silent unauth audit" to "explicit RBAC denial"; the test body now pins the new contract.
* `tests/app/{agent-detail-memory,cost-page,loop-detail,loops-page,schedules-page}.test.ts` — added `__setSessionSubjectForTest("owner")` in `beforeEach` so the rendered page passes a real session subject onto the caller. Asserted markup is unchanged.

Bun test summary after T03: **1143 pass / 0 fail / 6013 expect() calls**.

## Phase 4 invariant checklist

- [x] **CSRF guard:** unchanged — every mutation still lands on
      `/api/trpc/*` and runs through `csrfGuard` before the procedure
      sees the request.
- [x] **Rate limit:** unchanged. INDEX §"Phase 4 invariant" wishes
      RBAC ran *before* rate-limit so denials don't burn tokens; in
      practice rate-limit lives at the route layer (it doesn't know
      the procedure name yet) and RBAC at the procedure layer. The
      30/min/user bucket is generous enough that accidental denials
      never approach the cap. Recorded in T03 review §"Order of
      guards".
- [x] **`appendAudit`:** new action `rbac_denied` (replaces T02's
      inline emission). `resource_type` is the requested route
      (e.g. `tasks.kill`, `users.invite`, `audit.list`); payload is
      `{ requiredRole, callerRole, resourceUserId? }`. The
      `requireOwnerOrSelf` carve-out emits TWO rows when both gates
      fire (auth-gate for anonymous; auth-then-own-gate for member-on-
      other) — documented in `rbac.test.ts` ("layered-guard
      behaviour") and verified by the matrix audit-invariants test.
- [x] **DangerConfirm:** unchanged.
- [x] **No optimistic UI:** no UI surface in this task.

## Files touched

```
M src/server/audit.ts                    (no change; referenced)
A src/server/rbac.ts                     (NEW — central RBAC module)
M src/server/trpc.ts                     (authedProcedure + ownerProcedure)
A src/server/session.ts                  (NEW — page-side getSessionSubject + test seam)
M src/server/routers/agents.ts           (publicProcedure → authedProcedure)
M src/server/routers/analytics.ts        (publicProcedure → authedProcedure)
M src/server/routers/audit.ts            (publicProcedure → ownerProcedure + Phase 2 deferral note removed)
M src/server/routers/loops.ts            (authedProcedure + own-resource carve-out on approve/reject/cancel + lookupLoop returns userId)
M src/server/routers/permissions.ts      (publicProcedure → authedProcedure)
M src/server/routers/schedules.ts        (authedProcedure + own-resource carve-out in action factory + lookupSchedule returns userId)
M src/server/routers/tasks.ts            (authedProcedure + own-resource carve-out on kill + tasks.userId surfaced)
M src/server/routers/users.ts            (inline requireOwner replaced with ownerProcedure middleware)
M app/{agents,agents/[name],audit,cost,loops,loops/[loopId],schedules,tasks,tasks/[id]}/page.tsx  (forward session subject to createCaller)

A tests/server/rbac.test.ts              (NEW — 19 unit tests for the helpers)
A tests/server/rbac-matrix.test.ts       (NEW — 62 cases including the 48-cell matrix)
M tests/server/{agents,analytics,audit-router,audit-router-perf,dispatch,kill,loops,schedules,tasks}-router.test.ts  (carry userId on createCaller; rewrite the 5 anon tests to expect UNAUTHORIZED + rbac_denied)
M tests/app/{agent-detail-memory,cost-page,loop-detail,loops-page,schedules-page}.test.ts  (set/clear session subject test seam)
```

## Verification

```bash
bun run typecheck    # green
bun run test         # 1143 pass / 0 fail / 6013 expect() calls
bun run build        # green; route table unchanged
```

## Acceptance (from INDEX)

- [x] **48 matrix cases pass.** `rbac-matrix.test.ts` runs every (procedure × role) cell from the INDEX matrix, including own-vs-other carve-outs, and pins each cell's verdict (`UNAUTHORIZED` / `FORBIDDEN` / `OK` / `NULL`).
- [x] **Member can kill own tasks; gets 403 on others'.** Verified by `tasks.kill (own)` and `tasks.kill (other)` rows of the matrix; same shape applied to `loops.cancel` and `schedules.remove`.
- [x] **Legacy `user_id IS NULL` carve-out documented + tested.** `tests/server/rbac.test.ts` ("allows member on legacy NULL user_id rows (CLI carve-out)") + `rbac-matrix.test.ts` ("legacy NULL-user_id row is killable by any member").
- [x] **Audit row for every denial.** Audit-invariants test in the matrix file walks every denial cell and asserts an `rbac_denied` row was written tagged with the procedure path.
- [x] **No leak via batch.** `RBAC matrix — denial does NOT leak via batch` test runs a member through `tasks.kill (other)` (FORBIDDEN) immediately followed by `agents.list` (200) and asserts the denial is still audited and not swallowed.
