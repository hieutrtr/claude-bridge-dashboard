// P4-T03 — RBAC helper module + tRPC procedure middleware.
//
// Phase 4 introduces two roles:
//
//   * owner   — can do anything. The env-password fallback sub
//               (`ENV_OWNER_USER_ID`) maps to a synthetic owner row.
//   * member  — invited via `users.invite`. Can dispatch tasks / start
//               loops / create schedules and act on resources THEY
//               own. Owner-only routes (user mgmt, audit list) refuse
//               with FORBIDDEN.
//
// The module exposes three families of guards:
//
//   1. `resolveCaller(ctx)` — pure resolver. Reads `ctx.userId`, runs
//      `resolveSessionUser`, falls back to the env-owner synthetic row
//      for the literal `ENV_OWNER_USER_ID` sub. Returns a tagged role:
//      "anonymous" | "unknown" | "member" | "owner".
//   2. `requireAuth(ctx, route)` / `requireOwner(ctx, route)` —
//      throwing variants. Audit a `rbac_denied` row on rejection so
//      the security viewer can pivot on the requested route.
//   3. `requireOwnerOrSelf({ ctx, route, resourceUserId })` — the
//      kill-own-tasks / cancel-own-loops / remove-own-schedules carve-
//      out. Members may only act when `resourceUserId === caller.id`
//      OR when the resource pre-dates Phase 4 multi-user (legacy
//      `user_id IS NULL` rows from the CLI; see INDEX §"Phase 4
//      invariant" + T03 §"legacy carve-out" in the task file).
//
// The audit row schema is FROZEN against T02's inline guard so
// existing tests keep passing — `action="rbac_denied"`, `resource_type`
// = the requested route (e.g. `users.invite`, `tasks.kill`), and a
// payload of shape `{ requiredRole, callerRole, resourceUserId? }`.
// Privacy: the email is never echoed; only the user id (if known).
//
// Failure-mode discipline — when the `users` table is unreachable
// (test seam without `BRIDGE_DB`), the resolver still recognises the
// literal `ENV_OWNER_USER_ID` sub via `envOwnerUser()` so the dev
// password-login path keeps flowing without DB writes.

import { TRPCError } from "@trpc/server";

import { appendAudit } from "./audit";
import {
  envOwnerUser,
  resolveSessionUser,
  type UserRow,
} from "./auth-users";
import { ENV_OWNER_USER_ID } from "@/src/lib/auth";

/**
 * Subset of the tRPC Context the RBAC helpers need. Declared locally
 * (rather than importing from `./trpc.ts`) so this module can be
 * imported FROM `./trpc.ts` without a circular dependency between the
 * middleware factory and the procedure helpers.
 */
export interface RbacContext {
  userId?: string | null;
  req?: Request;
}

export type CallerRole = "anonymous" | "unknown" | "member" | "owner";

export interface ResolvedCaller {
  /** Tagged role. `"unknown"` = a sub was present but did not match a `users` row. */
  role: CallerRole;
  /** Resolved user, or null for anonymous/unknown. */
  user: UserRow | null;
  /** The raw JWT subject claim, when present. */
  sub: string | null;
}

/**
 * Pure resolver — no audit writes, no throws. Tests rely on this to
 * assert the resolver behaviour without wiring up a DB seam for the
 * audit module.
 */
export function resolveCaller(ctx: RbacContext): ResolvedCaller {
  const sub = ctx.userId ?? null;
  if (!sub) return { role: "anonymous", user: null, sub: null };

  let user: UserRow | null = null;
  try {
    user = resolveSessionUser(sub);
  } catch {
    // Database unreachable in the test seam. Fall through to the
    // env-owner shortcut below so the dev password-login path keeps
    // working without a `users` row.
  }
  if (!user && sub === ENV_OWNER_USER_ID) {
    user = envOwnerUser();
  }
  if (!user) return { role: "unknown", user: null, sub };
  return { role: user.role, user, sub };
}

interface AuditDeniedInput {
  ctx: RbacContext;
  route: string;
  requiredRole: "authenticated" | "owner" | "owner_or_self";
  callerRole: CallerRole;
  callerId: string | null;
  resourceUserId?: string | null;
}

function auditDenied(input: AuditDeniedInput): void {
  const payload: Record<string, unknown> = {
    requiredRole: input.requiredRole,
    callerRole: input.callerRole,
  };
  if (input.resourceUserId !== undefined) {
    payload.resourceUserId = input.resourceUserId;
  }
  appendAudit({
    action: "rbac_denied",
    resourceType: input.route,
    userId: input.callerId,
    payload,
    req: input.ctx.req,
  });
}

/**
 * Authenticated-only guard. UNAUTHORIZED for anonymous / unknown sub /
 * revoked user. Returns the resolved row on success.
 */
export function requireAuth(ctx: RbacContext, route: string): UserRow {
  const c = resolveCaller(ctx);
  if (c.user) return c.user;
  auditDenied({
    ctx,
    route,
    requiredRole: "authenticated",
    callerRole: c.role,
    callerId: c.sub,
  });
  throw new TRPCError({
    code: "UNAUTHORIZED",
    message:
      c.role === "anonymous"
        ? "authentication required"
        : "session does not match a known user",
  });
}

/**
 * Owner-only guard. UNAUTHORIZED for anonymous/unknown, FORBIDDEN for
 * non-owner. Returns the resolved owner row on success.
 *
 * Audit shape matches T02's inline `requireOwner` exactly so the
 * existing `users-router.test.ts` assertions on `rbac_denied` rows
 * continue to pass after the migration.
 */
export function requireOwner(ctx: RbacContext, route: string): UserRow {
  const c = resolveCaller(ctx);
  if (c.user && c.user.role === "owner") return c.user;
  auditDenied({
    ctx,
    route,
    requiredRole: "owner",
    callerRole: c.role,
    callerId: c.user?.id ?? c.sub,
  });
  if (!c.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message:
        c.role === "anonymous"
          ? "authentication required"
          : "session does not match a known user",
    });
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "owner role required",
  });
}

export interface RequireOwnerOrSelfInput {
  ctx: RbacContext;
  route: string;
  /** `user_id` column from the resource being acted on. NULL = legacy carve-out. */
  resourceUserId: string | null;
}

/**
 * "Owner or own-resource" guard. Returns the caller's `UserRow` when:
 *   - role:owner — always.
 *   - role:member, `resourceUserId === null` — legacy carve-out for
 *     CLI-created tasks/loops/schedules that pre-date Phase 4.
 *   - role:member, `resourceUserId === caller.id` — kill/cancel/
 *     remove your own resource.
 *
 * FORBIDDEN otherwise. UNAUTHORIZED for anonymous/unknown.
 */
export function requireOwnerOrSelf(
  input: RequireOwnerOrSelfInput,
): UserRow {
  const user = requireAuth(input.ctx, input.route);
  if (user.role === "owner") return user;
  if (input.resourceUserId === null) return user;
  if (input.resourceUserId === user.id) return user;
  auditDenied({
    ctx: input.ctx,
    route: input.route,
    requiredRole: "owner_or_self",
    callerRole: user.role,
    callerId: user.id,
    resourceUserId: input.resourceUserId,
  });
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "must be owner or the resource owner",
  });
}
