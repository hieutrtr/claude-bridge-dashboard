// P2-T09 — `/api/stream/permissions` Server-Sent-Events endpoint.
//
// Read-only feed: emits an `init` event on connect with the current
// `pending` rows, then a `pending` event when a new row is created
// and a `resolved` event when a row's status flips to `approved` or
// `denied`. Polls SQLite every `SSE_PERMISSIONS_POLL_MS` (default
// 1500 ms — slightly faster than the daemon's 2-s permission poll
// so the toast clears within ≈ 2 s of the user clicking Allow).
// Heartbeat comment every `SSE_PERMISSIONS_HEARTBEAT_MS` (default
// 15_000 ms).
//
// The auth middleware (Phase 1 T02) gates the path behind the
// env-password JWT cookie. The route only `select`s — no mutation;
// the Allow / Deny mutation lives at `tasks.respond` (Phase 2 T09)
// behind CSRF + rate-limit guards.

import { sql } from "drizzle-orm";

import { permissions } from "../../../../src/db/schema";
import { getDb } from "../../../../src/server/db";
import { createPermissionStreamResponse } from "../../../../src/server/sse-permissions";
import type {
  PermissionSnapshot,
  PermissionStatus,
} from "../../../../src/lib/permissions-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_POLL_MS = 1500;
const DEFAULT_HEARTBEAT_MS = 15_000;
// 30 s tail window so a `pending → approved` flip is caught even
// when the dashboard polled the row right before the daemon's poll.
const RESOLVED_TAIL_MS = 30_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readSnapshot(): PermissionSnapshot[] {
  const db = getDb();
  // SQLite stores `responded_at` as `CURRENT_TIMESTAMP` (text). The
  // tail window filter compares against `datetime('now', '-30 second')`
  // so we're tolerant of TZ skew. Pending rows always pass the WHERE.
  const rows = db
    .select({
      id: permissions.id,
      sessionId: permissions.sessionId,
      toolName: permissions.toolName,
      command: permissions.command,
      description: permissions.description,
      status: permissions.status,
      createdAt: permissions.createdAt,
      timeoutSeconds: permissions.timeoutSeconds,
      respondedAt: permissions.respondedAt,
    })
    .from(permissions)
    .where(
      sql`${permissions.status} = 'pending' OR (${permissions.respondedAt} IS NOT NULL AND ${permissions.respondedAt} >= datetime('now', ${`-${Math.ceil(RESOLVED_TAIL_MS / 1000)} seconds`}))`,
    )
    .all();

  // Map to the strict snapshot shape — drop the tail-window-only
  // `respondedAt` column and coerce `status` into the typed enum
  // (defensive: an unknown daemon-side value bucketed as `pending`
  // would have us spam toasts; coerce non-`approved`/`denied` to
  // `pending` so the diff helper handles it predictably).
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    toolName: r.toolName,
    command: r.command,
    description: r.description,
    status: coerceStatus(r.status),
    createdAt: r.createdAt,
    timeoutSeconds: r.timeoutSeconds,
  }));
}

function coerceStatus(value: string | null): PermissionStatus {
  if (value === "approved") return "approved";
  if (value === "denied") return "denied";
  return "pending";
}

export function GET(req: Request): Response {
  return createPermissionStreamResponse({
    signal: req.signal,
    pollMs: envInt("SSE_PERMISSIONS_POLL_MS", DEFAULT_POLL_MS),
    heartbeatMs: envInt("SSE_PERMISSIONS_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS),
    readSnapshot,
  });
}
