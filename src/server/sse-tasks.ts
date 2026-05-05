// T08 — Build a Server-Sent-Events `Response` for the
// `/api/stream/tasks` endpoint. Polls a `readSnapshot` callback every
// `pollMs`, diffs against the previous snapshot, emits one `update`
// event per changed task. Sends an `init` event with the current
// snapshot on connect, and a `: heartbeat` comment every
// `heartbeatMs` so proxies don't drop the idle connection.
//
// Pulled out of the route handler so unit tests can drive it with a
// fake `readSnapshot` and a short `pollMs` without spinning up a real
// HTTP server or DB.

import {
  SSE_HEARTBEAT_COMMENT,
  diffTaskSnapshots,
  formatSseComment,
  formatSseEvent,
  type TaskSnapshot,
} from "../lib/sse";

export interface CreateTaskStreamOptions {
  signal: AbortSignal;
  pollMs: number;
  heartbeatMs: number;
  readSnapshot: () => TaskSnapshot[];
}

export function createTaskStreamResponse(opts: CreateTaskStreamOptions): Response {
  const { signal, pollMs, heartbeatMs, readSnapshot } = opts;
  const encoder = new TextEncoder();
  let prev = new Map<number, TaskSnapshot>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let abortHandler: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed (consumer cancelled).
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer !== null) clearInterval(pollTimer);
        if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
        if (abortHandler !== null) {
          signal.removeEventListener("abort", abortHandler);
        }
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      try {
        const initial = readSnapshot();
        prev = new Map(initial.map((row) => [row.id, row]));
        safeEnqueue(formatSseEvent("init", { tasks: initial }));
      } catch (err) {
        safeEnqueue(
          formatSseEvent("error", { message: errorMessage(err) }),
        );
      }

      if (signal.aborted) {
        cleanup();
        return;
      }

      pollTimer = setInterval(() => {
        try {
          const curr = readSnapshot();
          const { events, nextSnapshot } = diffTaskSnapshots(prev, curr);
          prev = nextSnapshot;
          for (const ev of events) {
            safeEnqueue(formatSseEvent("update", ev));
          }
        } catch (err) {
          safeEnqueue(
            formatSseEvent("error", { message: errorMessage(err) }),
          );
        }
      }, pollMs);

      heartbeatTimer = setInterval(() => {
        safeEnqueue(SSE_HEARTBEAT_COMMENT);
      }, heartbeatMs);

      abortHandler = () => {
        cleanup();
      };
      signal.addEventListener("abort", abortHandler);
    },
    cancel() {
      closed = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      if (abortHandler !== null) {
        signal.removeEventListener("abort", abortHandler);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-export for ergonomic imports from the route handler / tests.
export { formatSseComment, type TaskSnapshot };
