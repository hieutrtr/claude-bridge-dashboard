// P2-T09 — Build a Server-Sent-Events `Response` for the
// `/api/stream/permissions` endpoint. Polls `readSnapshot` every
// `pollMs`, diffs against the previous snapshot via the pure
// `diffPermissionSnapshots` helper, emits one `pending` event per new
// pending row and one `resolved` event per status flip. Sends an
// `init` event with the initial snapshot on connect, and a
// `: heartbeat` comment every `heartbeatMs` so reverse proxies don't
// drop idle connections.
//
// Pulled out of the route handler so unit tests can drive it with a
// fake `readSnapshot` and a short `pollMs` without spinning up a real
// HTTP server or DB.

import {
  diffPermissionSnapshots,
  type PermissionSnapshot,
} from "../lib/permissions-stream";
import {
  SSE_HEARTBEAT_COMMENT,
  formatSseEvent,
} from "../lib/sse";

export interface CreatePermissionStreamOptions {
  signal: AbortSignal;
  pollMs: number;
  heartbeatMs: number;
  readSnapshot: () => PermissionSnapshot[];
}

export function createPermissionStreamResponse(
  opts: CreatePermissionStreamOptions,
): Response {
  const { signal, pollMs, heartbeatMs, readSnapshot } = opts;
  const encoder = new TextEncoder();
  let prev = new Map<string, PermissionSnapshot>();
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
          // Controller already closed.
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
        // The init payload only ships the *pending* rows so the toast
        // doesn't flash already-resolved entries that landed in the
        // 30s tail window.
        const initPending = initial.filter((r) => r.status === "pending");
        safeEnqueue(formatSseEvent("init", { permissions: initPending }));
      } catch (err) {
        safeEnqueue(formatSseEvent("error", { message: errorMessage(err) }));
      }

      if (signal.aborted) {
        cleanup();
        return;
      }

      pollTimer = setInterval(() => {
        try {
          const curr = readSnapshot();
          const { pendingEvents, resolvedEvents, nextSnapshot } =
            diffPermissionSnapshots(prev, curr);
          prev = nextSnapshot;
          for (const ev of pendingEvents) {
            safeEnqueue(formatSseEvent("pending", ev));
          }
          for (const ev of resolvedEvents) {
            safeEnqueue(formatSseEvent("resolved", ev));
          }
        } catch (err) {
          safeEnqueue(formatSseEvent("error", { message: errorMessage(err) }));
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
