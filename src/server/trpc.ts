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
export const createCallerFactory = t.createCallerFactory;
