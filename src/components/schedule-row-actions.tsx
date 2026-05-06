"use client";

// P3-T7 — per-row inline action menu on `/schedules`. Three controls:
//
//   * Pause / Resume — single button that flips its label + icon based
//     on `enabled`. Uses `runOptimistic` (P2-T10) so the icon flips
//     synchronously and rolls back on a 5xx.
//   * Delete — destructive; wraps `<DangerConfirm verb="Delete"
//     subject="schedule <name>" expectedConfirmation={name}>` from
//     Phase 2 T11. Server-confirmed (no optimistic flip).
//
// `useRouter` is wrapped in try/catch so that the page-level SSR test
// (`tests/app/schedules-page.test.ts`) doesn't crash when this island
// renders without an `AppRouterContext`. In any real Next.js render
// path the context is mounted; the catch path is dead code that
// degrades to `window.location.reload()`. Same pattern as
// `<LoopControls>` from P3-T4.
//
// Two named exports:
//   * `ScheduleRowActionsView` — pure props-driven markup. No hooks,
//     no fetch. Tested with `renderToStaticMarkup` across the state
//     matrix.
//   * `ScheduleRowActions`     — wrapper that owns local state, reads
//     CSRF from `document.cookie` once, and drives the two fetches.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/src/components/ui/button";
import { DangerConfirm } from "@/src/components/danger-confirm";
import { ScheduleRunsTrigger } from "@/src/components/schedule-runs-drawer";
import {
  DispatchError,
  readCsrfTokenFromCookie,
} from "@/src/lib/dispatch-client";
import {
  ScheduleActionError,
  buildScheduleActionRequest,
  parseTrpcResponse,
  type ScheduleAction,
  type ScheduleActionResult,
} from "@/src/lib/schedule-action-client";
import { runOptimistic } from "@/src/lib/optimistic";

export type ScheduleRowActionsStatus =
  | "idle"
  | "submitting"
  | "error";

export interface ScheduleRowActionsViewProps {
  scheduleId: number;
  scheduleName: string;
  /** Optimistic-aware enabled flag (flips before the network resolves). */
  enabled: boolean;
  status: ScheduleRowActionsStatus;
  errorCode: string | null;
  errorMessage: string | null;
  csrfMissing: boolean;
  onTogglePause?: () => void;
  /** Returns the promise the dialog awaits (success → null; failure → throws). */
  onDeleteSubmit?: () => Promise<{ alreadyTerminated?: boolean } | void>;
  onDeleteResolved?: () => void;
}

export function ScheduleRowActionsView(props: ScheduleRowActionsViewProps) {
  const submitting = props.status === "submitting";
  const pauseLabel = props.enabled ? "Pause" : "Resume";
  const pauseTestId = props.enabled
    ? "schedule-pause-trigger"
    : "schedule-resume-trigger";

  return (
    <div
      role="group"
      aria-label={`Actions for ${props.scheduleName}`}
      data-testid="schedule-row-actions"
      className="flex items-center justify-end gap-1"
    >
      <ScheduleRunsTrigger
        scheduleId={props.scheduleId}
        scheduleName={props.scheduleName}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid={pauseTestId}
        data-state={props.enabled ? "active" : "paused"}
        disabled={submitting || props.csrfMissing}
        onClick={props.onTogglePause}
        title={
          props.enabled
            ? `Pause ${props.scheduleName}`
            : `Resume ${props.scheduleName}`
        }
        className="px-2"
      >
        <span aria-hidden="true" className="mr-1 font-mono text-xs">
          {props.enabled ? "⏸" : "▶"}
        </span>
        {pauseLabel}
      </Button>

      <DangerConfirm
        verb="Delete"
        subject={`schedule ${props.scheduleName}`}
        expectedConfirmation={props.scheduleName}
        trigger={
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="schedule-delete-trigger"
            disabled={submitting || props.csrfMissing}
            title={`Delete ${props.scheduleName}`}
            className="border-red-500/40 px-2 text-red-300 hover:bg-red-500/10"
          >
            <span aria-hidden="true" className="mr-1 font-mono text-xs">
              ✕
            </span>
            Delete
          </Button>
        }
        onSubmit={async () => {
          // The dialog awaits this promise; reject → dialog renders the
          // error envelope; resolve → success copy. The View doesn't
          // know the wire format — `onDeleteSubmit` does the bridging.
          if (props.onDeleteSubmit) {
            return props.onDeleteSubmit();
          }
          return undefined;
        }}
        onSuccess={props.onDeleteResolved}
      />

      {props.status === "error" ? (
        <span
          data-testid="schedule-row-actions-error"
          role="status"
          aria-live="polite"
          className="ml-2 rounded-md border border-red-500/40 bg-red-500/5 px-2 py-1 text-xs text-red-300"
        >
          <span className="font-mono font-semibold">{props.errorCode}</span>
          {" — "}
          {props.errorMessage ?? "request failed"}
        </span>
      ) : null}
    </div>
  );
}

export interface ScheduleRowActionsProps {
  scheduleId: number;
  scheduleName: string;
  enabled: boolean;
}

// `useRouter` throws when there is no `AppRouterContext` provider —
// that's the case in the schedules-page SSR-test flow. The try/catch
// is a deliberate escape hatch identical to `useSafeRouterRefresh` in
// `<LoopControls>` (P3-T4).
function useSafeRouterRefresh(): () => void {
  try {
    const router = useRouter();
    return () => router.refresh();
  } catch {
    return () => {
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    };
  }
}

export function ScheduleRowActions({
  scheduleId,
  scheduleName,
  enabled: initialEnabled,
}: ScheduleRowActionsProps) {
  const refresh = useSafeRouterRefresh();

  // Optimistic local copy of `enabled` — flips synchronously when the
  // user clicks Pause/Resume, rolls back if the request rejects.
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<ScheduleRowActionsStatus>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [csrfMissing, setCsrfMissing] = useState(false);

  const sendAction = useCallback(
    async (action: ScheduleAction): Promise<ScheduleActionResult> => {
      const csrf = readCsrfTokenFromCookie(document.cookie);
      if (csrf === null) {
        setCsrfMissing(true);
        throw new DispatchError(
          "FORBIDDEN",
          "Session expired — reload the page.",
        );
      }
      setCsrfMissing(false);
      const { url, init } = buildScheduleActionRequest(
        action,
        { id: scheduleId },
        csrf,
      );
      const res = await fetch(url, init);
      const json: unknown = await res.json();
      try {
        return parseTrpcResponse<ScheduleActionResult>(json);
      } catch (err) {
        if (err instanceof ScheduleActionError) {
          throw new DispatchError(err.code, err.message);
        }
        throw err;
      }
    },
    [scheduleId],
  );

  const togglePause = useCallback(async () => {
    if (status === "submitting") return;
    const action: ScheduleAction = enabled ? "pause" : "resume";
    const next = !enabled;
    setStatus("submitting");
    setErrorCode(null);
    setErrorMessage(null);

    try {
      await runOptimistic({
        // Optimistic apply: flip the local `enabled` flag before the
        // request. Rollback on rejection. P2-T10 contract.
        apply: () => setEnabled(next),
        rollback: () => setEnabled(!next),
        fetcher: () => sendAction(action),
      });
      setStatus("idle");
      // Server has confirmed; refresh so the underlying row reflects
      // the daemon-of-record state (run_count, next_run_at, etc.).
      refresh();
    } catch (err) {
      const e =
        err instanceof DispatchError
          ? err
          : new DispatchError("INTERNAL_SERVER_ERROR", String(err));
      setErrorCode(e.code);
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, [enabled, refresh, sendAction, status]);

  const deleteSubmit = useCallback(async (): Promise<void> => {
    // No optimistic flip on delete — the row stays visible until the
    // dialog transitions to "success", at which point the page
    // refreshes and the row is gone server-side.
    await sendAction("remove");
  }, [sendAction]);

  return (
    <ScheduleRowActionsView
      scheduleId={scheduleId}
      scheduleName={scheduleName}
      enabled={enabled}
      status={status}
      errorCode={errorCode}
      errorMessage={errorMessage}
      csrfMissing={csrfMissing}
      onTogglePause={() => void togglePause()}
      onDeleteSubmit={deleteSubmit}
      onDeleteResolved={refresh}
    />
  );
}
