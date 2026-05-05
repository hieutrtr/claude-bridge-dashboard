// T08 — `/api/stream/tasks` Server-Sent-Events endpoint.
//
// Read-only feed: emits an `init` event on connect with the most-recent
// 200 task rows (id / status / costUsd / completedAt) plus an `update`
// event per row that changed since the previous poll. Polls SQLite
// every `SSE_TASKS_POLL_MS` (default 1000 ms). Heartbeat comment every
// `SSE_TASKS_HEARTBEAT_MS` (default 15 000 ms) keeps idle connections
// alive across reverse proxies.
//
// Per Phase 1 read-only invariant, this route only `select`s — no
// mutation. The auth middleware (T02) gates the path behind the
// env-password JWT cookie.

import { desc } from "drizzle-orm";

import { tasks } from "../../../../src/db/schema";
import { getDb } from "../../../../src/server/db";
import { createTaskStreamResponse } from "../../../../src/server/sse-tasks";
import type { TaskSnapshot } from "../../../../src/lib/sse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SNAPSHOT_LIMIT = 200;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_HEARTBEAT_MS = 15_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readSnapshot(): TaskSnapshot[] {
  return getDb()
    .select({
      id: tasks.id,
      status: tasks.status,
      costUsd: tasks.costUsd,
      completedAt: tasks.completedAt,
    })
    .from(tasks)
    .orderBy(desc(tasks.id))
    .limit(SNAPSHOT_LIMIT)
    .all();
}

export function GET(req: Request): Response {
  return createTaskStreamResponse({
    signal: req.signal,
    pollMs: envInt("SSE_TASKS_POLL_MS", DEFAULT_POLL_MS),
    heartbeatMs: envInt("SSE_TASKS_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS),
    readSnapshot,
  });
}
