// P2-T09 — pure helpers for the `/api/stream/permissions` SSE endpoint.
//
// `diffPermissionSnapshots` compares two consecutive polls of the
// daemon-owned `permissions` table and returns the minimal set of
// `pending` / `resolved` events the toast needs to update its state.
//
// IO-free: no SQLite import, no React, no DOM. Mirrors the shape of
// `src/lib/sse.ts` — same pattern, separate event vocabulary so the
// `/api/stream/tasks` consumers stay untouched.

export type PermissionStatus = "pending" | "approved" | "denied";

export interface PermissionSnapshot {
  id: string;
  sessionId: string;
  toolName: string;
  command: string | null;
  description: string | null;
  status: PermissionStatus;
  createdAt: string | null;
  timeoutSeconds: number | null;
}

export interface PendingEvent {
  id: string;
  sessionId: string;
  toolName: string;
  command: string | null;
  description: string | null;
  createdAt: string | null;
  timeoutSeconds: number | null;
}

export interface ResolvedEvent {
  id: string;
  status: "approved" | "denied";
}

export interface PermissionDiffResult {
  pendingEvents: PendingEvent[];
  resolvedEvents: ResolvedEvent[];
  nextSnapshot: Map<string, PermissionSnapshot>;
}

export function diffPermissionSnapshots(
  prev: Map<string, PermissionSnapshot>,
  curr: PermissionSnapshot[],
): PermissionDiffResult {
  const pendingEvents: PendingEvent[] = [];
  const resolvedEvents: ResolvedEvent[] = [];
  const nextSnapshot = new Map<string, PermissionSnapshot>();
  const seen = new Set<string>();

  for (const row of curr) {
    nextSnapshot.set(row.id, row);
    seen.add(row.id);

    const before = prev.get(row.id);

    if (before === undefined) {
      // Brand-new row. Only synthesize a `pending` event when the
      // row is actually pending — already-resolved rows in the
      // 30-second tail window must not flash a toast on dashboard
      // reload.
      if (row.status === "pending") {
        pendingEvents.push({
          id: row.id,
          sessionId: row.sessionId,
          toolName: row.toolName,
          command: row.command,
          description: row.description,
          createdAt: row.createdAt,
          timeoutSeconds: row.timeoutSeconds,
        });
      }
      continue;
    }

    if (before.status === "pending" && row.status !== "pending") {
      resolvedEvents.push({
        id: row.id,
        status: row.status,
      });
    }
  }

  // Rows that were `pending` last tick and have disappeared entirely
  // emit a defensive `resolved{status:"denied"}` so the toast clears.
  // Already-resolved rows naturally roll off the 30s tail window —
  // no event needed (the toast cleared them when they flipped).
  for (const [id, before] of prev) {
    if (seen.has(id)) continue;
    if (before.status === "pending") {
      resolvedEvents.push({ id, status: "denied" });
    }
  }

  return { pendingEvents, resolvedEvents, nextSnapshot };
}
