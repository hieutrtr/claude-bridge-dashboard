// T08 — Pure helpers for the `/api/stream/tasks` SSE endpoint.
//
// `formatSseEvent` / `formatSseComment` produce the on-the-wire frames
// per the Server-Sent-Events spec
// (https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream).
// `diffTaskSnapshots` compares two consecutive polls and returns the
// minimal set of "task changed" events plus the next snapshot map.
//
// IO-free: this file imports nothing runtime-specific and is safe to use
// from both the route handler and unit tests.

export interface TaskSnapshot {
  id: number;
  status: string | null;
  costUsd: number | null;
  completedAt: string | null;
}

export interface TaskUpdateEvent {
  id: number;
  status: string | null;
  costUsd: number | null;
  completedAt: string | null;
}

export interface DiffResult {
  events: TaskUpdateEvent[];
  nextSnapshot: Map<number, TaskSnapshot>;
}

export const SSE_HEARTBEAT_COMMENT = ": heartbeat\n\n";

export function formatSseEvent(event: string, data: unknown): string {
  const body =
    typeof data === "string" ? data : JSON.stringify(data);
  // Per spec: a single field can span multiple lines by emitting
  // `data: <line>` once per line; the consumer concatenates with
  // newlines.
  const dataLines = body.split("\n").map((line) => `data: ${line}`).join("\n");
  return `event: ${event}\n${dataLines}\n\n`;
}

export function formatSseComment(text: string): string {
  return `: ${text}\n\n`;
}

export function diffTaskSnapshots(
  prev: Map<number, TaskSnapshot>,
  curr: TaskSnapshot[],
): DiffResult {
  const events: TaskUpdateEvent[] = [];
  const nextSnapshot = new Map<number, TaskSnapshot>();
  for (const row of curr) {
    nextSnapshot.set(row.id, row);
    const before = prev.get(row.id);
    if (before === undefined || changed(before, row)) {
      events.push({
        id: row.id,
        status: row.status,
        costUsd: row.costUsd,
        completedAt: row.completedAt,
      });
    }
  }
  return { events, nextSnapshot };
}

function changed(a: TaskSnapshot, b: TaskSnapshot): boolean {
  return (
    a.status !== b.status ||
    a.costUsd !== b.costUsd ||
    a.completedAt !== b.completedAt
  );
}
