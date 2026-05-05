// T01 — MCP transport error → tRPC error mapping. Shared by every
// mutation procedure that calls into the pool (T01 dispatch, T03 kill,
// T06 loops.approve/reject), so the wire-level codes the client sees
// stay consistent across the mutation surface.
//
// Mapping rationale (see docs/tasks/phase-2/T01-dispatch.md §"Error
// mapping"):
//
//   MCP_TIMEOUT          → TIMEOUT                 — client retries with backoff
//   MCP_BACKPRESSURE     → TOO_MANY_REQUESTS       — client throttles + retries
//   MCP_CONNECTION_LOST  → INTERNAL_SERVER_ERROR   — daemon restarted; retry
//   MCP_CONNECTION_CLOSED→ INTERNAL_SERVER_ERROR
//   MCP_SPAWN_FAILED     → INTERNAL_SERVER_ERROR   — `bridge mcp` missing
//   MCP_ABORTED          → CLIENT_CLOSED_REQUEST   — user navigated away
//   MCP_RPC_ERROR        → INTERNAL_SERVER_ERROR   — daemon-reported failure
//   any other            → INTERNAL_SERVER_ERROR
//
// Forward the original `Error` as `cause` so the server-side log
// preserves the underlying stack while the client gets a typed code.

import { TRPCError } from "@trpc/server";

import { McpPoolError, type McpErrorCode } from "./pool";

// Subset of `TRPC_ERROR_CODE_KEY` we actually emit. Keeping the type
// local avoids a deep `@trpc/server/unstable-core-do-not-import` import
// while still constraining the table at compile time.
type TrpcCode =
  | "TIMEOUT"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL_SERVER_ERROR"
  | "CLIENT_CLOSED_REQUEST";

/** The `code` value recorded in `audit_log.payload_json` for failures. */
export type AuditFailureCode = McpErrorCode | "unexpected" | "malformed_response";

const CODE_MAP: Record<McpErrorCode, TrpcCode> = {
  MCP_TIMEOUT: "TIMEOUT",
  MCP_BACKPRESSURE: "TOO_MANY_REQUESTS",
  MCP_CONNECTION_LOST: "INTERNAL_SERVER_ERROR",
  MCP_CONNECTION_CLOSED: "INTERNAL_SERVER_ERROR",
  MCP_SPAWN_FAILED: "INTERNAL_SERVER_ERROR",
  MCP_ABORTED: "CLIENT_CLOSED_REQUEST",
  MCP_RPC_ERROR: "INTERNAL_SERVER_ERROR",
};

const MESSAGE_MAP: Record<McpErrorCode, string> = {
  MCP_TIMEOUT: "Daemon did not respond within timeout",
  MCP_BACKPRESSURE: "Dashboard MCP queue full — retry in a moment",
  MCP_CONNECTION_LOST: "Connection to daemon lost — retry",
  MCP_CONNECTION_CLOSED: "MCP pool closed",
  MCP_SPAWN_FAILED: "Could not start daemon MCP — check that `bridge mcp` is installed",
  MCP_ABORTED: "Request aborted",
  MCP_RPC_ERROR: "Daemon reported an error",
};

/**
 * Map any error thrown by `McpClient.call` to a TRPCError with the
 * appropriate code + message. Non-`McpPoolError` failures degrade to
 * `INTERNAL_SERVER_ERROR` with the original message preserved on
 * `cause`.
 */
export function mapMcpErrorToTrpc(err: unknown): TRPCError {
  if (err instanceof McpPoolError) {
    const code = CODE_MAP[err.code];
    let message = MESSAGE_MAP[err.code];
    if (err.code === "MCP_RPC_ERROR" && err.message) {
      message = `${message}: ${err.message}`;
    }
    return new TRPCError({ code, message, cause: err });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : "unexpected MCP error",
    cause: err,
  });
}

/**
 * Extract the `audit_log.payload_json.code` field for a failure. Pure —
 * tests + procedures both call this so the audit shape stays consistent.
 */
export function auditFailureCode(err: unknown): AuditFailureCode {
  if (err instanceof McpPoolError) return err.code;
  return "unexpected";
}
