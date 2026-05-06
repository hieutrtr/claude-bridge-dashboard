"use client";

// P3-T4 — cancel-loop button on `/loops/[loopId]`. Thin client wrapper
// around `<DangerConfirm>` (the reusable confirmation primitive from
// Phase 2 T11). Same shape as `<KillTaskButton>` except the underlying
// mutation is `loops.cancel` and the confirmation token is a 8-char
// prefix of the `loop_id` (not the full UUID — typing 36 chars on a
// phone is hostile).
//
// Render policy:
//   * loop in a terminal status (done / cancelled / failed) — server
//     would return `alreadyFinalized:true` immediately; suppress the
//     button so the page doesn't dangle a meaningless control.
//   * everything else (running, pending_approval) — render the Cancel
//     trigger; the server handles edge cases.
//
// No optimistic UI per Phase 3 INDEX scope decision (cancel is
// server-confirmed because the daemon owns the race window vs the
// Telegram channel — same precedent as approve/reject in Phase 2 T06).

import { Button } from "@/src/components/ui/button";
import { DangerConfirm } from "@/src/components/danger-confirm";
import { DispatchError, readCsrfTokenFromCookie } from "@/src/lib/dispatch-client";
import {
  LoopMutationError,
  buildLoopCancelRequest,
  parseTrpcResponse,
  type LoopGateResult,
} from "@/src/lib/loop-mutation-client";

const TERMINAL_LOOP_STATUSES = new Set([
  "done",
  "cancelled",
  "canceled",
  "failed",
]);

/** First 8 chars of the loop_id is the typed confirmation. */
export const LOOP_CANCEL_CONFIRM_LENGTH = 8;

interface Props {
  loopId: string;
  status: string | null;
  /** Called once after a successful cancel so the caller can refresh. */
  onCancelled?: () => void;
}

export function LoopCancelButton({ loopId, status, onCancelled }: Props) {
  if (status !== null && TERMINAL_LOOP_STATUSES.has(status)) return null;

  const confirmToken = loopId.slice(0, LOOP_CANCEL_CONFIRM_LENGTH);

  return (
    <DangerConfirm
      verb="Cancel"
      subject={`loop ${confirmToken}…`}
      expectedConfirmation={confirmToken}
      trigger={
        <Button
          type="button"
          variant="outline"
          data-testid="loop-cancel-trigger"
          className="border-red-500/40 text-red-300 hover:bg-red-500/10"
        >
          Cancel loop
        </Button>
      }
      onSubmit={async () => {
        const csrf = readCsrfTokenFromCookie(document.cookie);
        if (csrf === null) {
          throw new DispatchError(
            "FORBIDDEN",
            "Session expired — reload the page.",
          );
        }
        try {
          const { url, init } = buildLoopCancelRequest({ loopId }, csrf);
          const res = await fetch(url, init);
          const json: unknown = await res.json();
          const result = parseTrpcResponse<LoopGateResult>(json);
          // The DangerConfirm dialog reads `alreadyTerminated` to decide
          // its success copy; map our `alreadyFinalized` flag to that
          // contract so the existing dialog works unchanged.
          return { alreadyTerminated: result.alreadyFinalized };
        } catch (err) {
          // The wrapper ships a typed `DispatchError` so the dialog can
          // render `code` + `message`; cross-bridge our LoopMutationError
          // into that shape.
          if (err instanceof LoopMutationError) {
            throw new DispatchError(err.code, err.message);
          }
          throw err;
        }
      }}
      onSuccess={onCancelled}
    />
  );
}
