// T5 — tRPC v11 base. Single shared `t` instance so every router uses the
// same transformer, error formatter, and context type.
//
// T01 (Phase 2) widens the context: mutation procedures need (a) the
// originating Request to derive `ip_hash` + UA + request_id for the
// `audit_log` row (T04), (b) the resolved JWT subject so audit + future
// authz middleware know who acted, and (c) the MCP client so the
// procedure can call into the daemon. Queries from Phase 1 ignore these
// fields and continue to compile (all three are optional).

import { initTRPC } from "@trpc/server";

import type { McpClient } from "./mcp/pool";
import { requireAuth, requireOwner } from "./rbac";

export interface Context {
  /** Original Request — used by audit for ip_hash + UA + request_id. */
  req?: Request;
  /** Resolved JWT subject, or null when unauthenticated. */
  userId?: string | null;
  /** MCP transport client. Required for mutation procedures. */
  mcp?: McpClient;
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;

// P4-T03 — RBAC middleware-backed procedures.
//
// `authedProcedure` — UNAUTHORIZED for anonymous / revoked / unknown
//   sub. Used for read endpoints + mutations that members are allowed
//   to perform (`tasks.dispatch`, `loops.start`, `schedules.add`).
// `ownerProcedure` — UNAUTHORIZED for the same anon/unknown set;
//   FORBIDDEN for `role:member`. Used for owner-only routes
//   (`users.*`, `audit.list`, future `agents.delete`).
//
// Each middleware audits a `rbac_denied` row on rejection so the
// security viewer can pivot on the requested route. The route name
// passed to the helper comes from tRPC's `path` (the dotted procedure
// path, e.g. `users.invite`) so the audit `resource_type` matches the
// shape `users` router previously emitted from its inline guard.
export const authedProcedure = t.procedure.use(({ ctx, next, path }) => {
  const user = requireAuth(ctx, path);
  return next({ ctx: { ...ctx, user, userId: user.id } });
});

export const ownerProcedure = t.procedure.use(({ ctx, next, path }) => {
  const user = requireOwner(ctx, path);
  return next({ ctx: { ...ctx, user, userId: user.id } });
});
