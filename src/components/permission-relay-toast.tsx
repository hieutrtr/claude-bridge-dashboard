"use client";

// P2-T09 — permission relay toast. Subscribes to
// `/api/stream/permissions` via EventSource, renders a stacked toast
// for each pending row, and lets the user Allow / Deny via a tRPC
// mutation. The Allow / Deny click flips the row in the daemon's
// `permissions` table; the daemon's PreToolUse hook polls that row
// and unblocks within ≈ 2 s.
//
// Two named exports, mirroring the dispatch dialog (T02) and the
// danger-confirm primitive (T11):
//   * `PermissionRelayToastView` — pure props-driven markup. No
//     hooks, no DOM, no fetch. Tested via `renderToStaticMarkup`.
//   * `PermissionRelayToast`     — `"use client"` wrapper that owns
//     the EventSource subscription, the local item list, and the
//     submit fetch. Mounted once globally in `app/layout.tsx`.

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/src/components/ui/button";
import {
  RESPOND_URL,
  buildRespondRequest,
  parseTrpcResponse,
  readCsrfTokenFromCookie,
  DispatchError,
} from "@/src/lib/permissions-client";
import type {
  PermissionDecision,
  RespondResult,
} from "@/src/lib/permissions-client";

// Maximum command preview length before we truncate with an ellipsis.
// Permissions can carry pasted shell snippets; we don't want a
// multi-KB command blowing out the toast.
const COMMAND_PREVIEW_LIMIT = 200;

export type PermissionToastItemStatus = "idle" | "submitting" | "error";

export interface PermissionToastItem {
  id: string;
  sessionId: string;
  toolName: string;
  command: string | null;
  description: string | null;
  status: PermissionToastItemStatus;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PermissionRelayToastViewProps {
  items: PermissionToastItem[];
  csrfMissing: boolean;
  onRespond?: (id: string, decision: PermissionDecision) => void;
  onDismiss?: (id: string) => void;
}

function truncateCommand(cmd: string | null): string | null {
  if (cmd === null) return null;
  if (cmd.length <= COMMAND_PREVIEW_LIMIT) return cmd;
  return `${cmd.slice(0, COMMAND_PREVIEW_LIMIT)}…`;
}

export function PermissionRelayToastView(
  props: PermissionRelayToastViewProps,
) {
  if (props.items.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-full max-w-md flex-col-reverse gap-2"
    >
      {props.items.map((item) => {
        const cmd = truncateCommand(item.command);
        const submitting = item.status === "submitting";
        const buttonsDisabled = submitting || props.csrfMissing;
        return (
          <div
            key={item.id}
            data-permission-id={item.id}
            className="pointer-events-auto rounded-md border border-amber-500/40 bg-[hsl(var(--background))] p-3 shadow-lg"
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-mono text-[hsl(var(--muted-foreground))]">
                  {item.id}
                </p>
                <p className="text-sm font-semibold tracking-tight text-amber-300">
                  Permission requested: {item.toolName}
                </p>
                {cmd !== null ? (
                  <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-all rounded bg-[hsl(var(--muted))] px-2 py-1 text-xs">
                    {cmd}
                  </pre>
                ) : null}
                {item.description !== null ? (
                  <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                    {item.description}
                  </p>
                ) : null}
              </div>
            </div>
            {props.csrfMissing ? (
              <p className="mb-2 text-xs text-red-300">
                Session expired — reload the dashboard before responding.
              </p>
            ) : null}
            {item.status === "error" ? (
              <p className="mb-2 text-xs text-red-300">
                <span className="font-mono font-semibold">{item.errorCode}</span>
                {" — "}
                {item.errorMessage ?? "request failed"}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={buttonsDisabled}
                onClick={() => props.onRespond?.(item.id, "denied")}
              >
                Deny
              </Button>
              <Button
                size="sm"
                type="button"
                disabled={buttonsDisabled}
                onClick={() => props.onRespond?.(item.id, "approved")}
              >
                Allow
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Wrapper
// ────────────────────────────────────────────────────────────────────

export interface PermissionRelayToastProps {
  /** Optional override for tests; defaults to `new EventSource(url)`. */
  eventSourceFactory?: (url: string) => EventSourceLike;
  /** Optional override for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Optional override for tests; defaults to `document.cookie`. */
  readCookie?: () => string;
  /** SSE URL — exposed for tests. Defaults to `/api/stream/permissions`. */
  streamUrl?: string;
}

/**
 * Minimal subset of the browser `EventSource` interface we depend on.
 * Lets the wrapper be exercised under bun:test with a stub.
 */
export interface EventSourceLike {
  addEventListener(
    event: string,
    listener: (ev: { data: string }) => void,
  ): void;
  close(): void;
}

interface InitPayload {
  permissions: Array<{
    id: string;
    sessionId: string;
    toolName: string;
    command: string | null;
    description: string | null;
  }>;
}

interface PendingPayload {
  id: string;
  sessionId: string;
  toolName: string;
  command: string | null;
  description: string | null;
}

interface ResolvedPayload {
  id: string;
  status: "approved" | "denied";
}

const DEFAULT_STREAM_URL = "/api/stream/permissions";

function defaultEventSource(url: string): EventSourceLike {
  return new EventSource(url) as unknown as EventSourceLike;
}

export function PermissionRelayToast(props: PermissionRelayToastProps = {}) {
  const [items, setItems] = useState<PermissionToastItem[]>([]);
  const [csrfMissing, setCsrfMissing] = useState(false);

  const streamUrl = props.streamUrl ?? DEFAULT_STREAM_URL;
  const fetchImpl = props.fetchImpl ?? fetch;
  const readCookie =
    props.readCookie ?? (() => (typeof document !== "undefined" ? document.cookie : ""));

  const upsertItem = useCallback((next: PermissionToastItem) => {
    setItems((prev) => {
      const idx = prev.findIndex((p) => p.id === next.id);
      if (idx === -1) return [...prev, next];
      const copy = prev.slice();
      copy[idx] = next;
      return copy;
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const respond = useCallback(
    async (id: string, decision: PermissionDecision) => {
      const csrfToken = readCsrfTokenFromCookie(readCookie());
      if (csrfToken === null) {
        setCsrfMissing(true);
        return;
      }
      // Capture the current item so we can re-insert with an error state
      // if the request fails.
      let snapshot: PermissionToastItem | undefined;
      setItems((prev) => {
        snapshot = prev.find((p) => p.id === id);
        return prev.map((p) =>
          p.id === id
            ? { ...p, status: "submitting", errorCode: null, errorMessage: null }
            : p,
        );
      });

      try {
        const { url, init } = buildRespondRequest({ id, decision }, csrfToken);
        const res = await fetchImpl(url, init);
        const json: unknown = await res.json();
        // Validate envelope; throws DispatchError on the error envelope.
        parseTrpcResponse<RespondResult>(json);
        // Server-confirmed success — remove the item; the SSE
        // `resolved` event would also remove it, but doing it here
        // means the user sees instant feedback rather than waiting
        // for the next 1.5-s poll tick.
        removeItem(id);
      } catch (err) {
        const e =
          err instanceof DispatchError
            ? err
            : new DispatchError("INTERNAL_SERVER_ERROR", String(err));
        if (snapshot) {
          upsertItem({
            ...snapshot,
            status: "error",
            errorCode: e.code,
            errorMessage: e.message,
          });
        }
      }
    },
    [fetchImpl, readCookie, removeItem, upsertItem],
  );

  useEffect(() => {
    setCsrfMissing(readCsrfTokenFromCookie(readCookie()) === null);
    const factory = props.eventSourceFactory ?? defaultEventSource;
    const source = factory(streamUrl);

    source.addEventListener("init", (ev) => {
      try {
        const payload = JSON.parse(ev.data) as InitPayload;
        setItems(
          (payload.permissions ?? []).map((p) => ({
            id: p.id,
            sessionId: p.sessionId,
            toolName: p.toolName,
            command: p.command,
            description: p.description,
            status: "idle",
            errorCode: null,
            errorMessage: null,
          })),
        );
      } catch {
        // malformed init — ignore; the next pending event will
        // populate the list.
      }
    });

    source.addEventListener("pending", (ev) => {
      try {
        const p = JSON.parse(ev.data) as PendingPayload;
        upsertItem({
          id: p.id,
          sessionId: p.sessionId,
          toolName: p.toolName,
          command: p.command,
          description: p.description,
          status: "idle",
          errorCode: null,
          errorMessage: null,
        });
      } catch {
        // ignore
      }
    });

    source.addEventListener("resolved", (ev) => {
      try {
        const r = JSON.parse(ev.data) as ResolvedPayload;
        removeItem(r.id);
      } catch {
        // ignore
      }
    });

    return () => {
      source.close();
    };
  }, [props.eventSourceFactory, streamUrl, upsertItem, removeItem, readCookie]);

  return (
    <PermissionRelayToastView
      items={items}
      csrfMissing={csrfMissing}
      onRespond={(id, decision) => void respond(id, decision)}
      onDismiss={removeItem}
    />
  );
}

/** Re-export for tests + Playwright. */
export { RESPOND_URL };
