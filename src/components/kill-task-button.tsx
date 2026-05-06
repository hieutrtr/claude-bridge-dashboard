"use client";

// P2-T11 + P2-T10 — kill-task button on `/tasks/[id]`. Thin client
// wrapper over `<DangerConfirm>` (the reusable confirmation primitive)
// with optional optimistic-lifecycle callbacks (P2-T10).
//
// Render policy:
//   * orphan task (`agentName === null`) — no kill target, render nothing.
//   * task in a terminal status (done / failed / killed) — server would
//     return `alreadyTerminated:true` immediately; surface a no-op by
//     rendering nothing.
//   * everything else (running, pending, queued, unknown) — render
//     the Kill trigger; the server handles edge cases.
//
// When the user confirms the dialog, `tasks.kill` is sent inside
// `runOptimistic` (P2-T10): the wrapper calls `onOptimisticBegin`
// synchronously, then awaits the network call, then either calls
// `onOptimisticSettle` (resolve) or `onOptimisticRollback` (reject)
// — and rethrows so `<DangerConfirm>` can transition to its `error`
// state. The callbacks are optional so existing call sites that
// don't render an outer optimistic badge still work unchanged.

import { Button } from "@/src/components/ui/button";
import { DangerConfirm } from "@/src/components/danger-confirm";
import {
  DispatchError,
  buildKillTaskRequest,
  parseTrpcResponse,
  readCsrfTokenFromCookie,
  type KillTaskResult,
} from "@/src/lib/danger-confirm-client";
import { runOptimistic } from "@/src/lib/optimistic";

interface Props {
  taskId: number;
  agentName: string | null;
  status: string | null;
  /** P2-T10 — fired synchronously when the dialog confirms, before the network call. */
  onOptimisticBegin?: () => void;
  /** P2-T10 — fired after the kill mutation resolves successfully. */
  onOptimisticSettle?: () => void;
  /** P2-T10 — fired after the kill mutation rejects, before the error rethrows. */
  onOptimisticRollback?: () => void;
}

const TERMINAL_STATUSES = new Set(["done", "failed", "killed"]);

export function KillTaskButton({
  taskId,
  agentName,
  status,
  onOptimisticBegin,
  onOptimisticSettle,
  onOptimisticRollback,
}: Props) {
  if (agentName === null) return null;
  if (status && TERMINAL_STATUSES.has(status)) return null;

  return (
    <DangerConfirm
      verb="Kill"
      subject={`task #${taskId} on agent ${agentName}`}
      expectedConfirmation={agentName}
      trigger={
        <Button
          type="button"
          variant="outline"
          className="border-red-500/40 text-red-300 hover:bg-red-500/10"
        >
          Kill
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
        const result = await runOptimistic<KillTaskResult>({
          apply: () => onOptimisticBegin?.(),
          rollback: () => onOptimisticRollback?.(),
          fetcher: async () => {
            const { url, init } = buildKillTaskRequest({ id: taskId }, csrf);
            const res = await fetch(url, init);
            const json: unknown = await res.json();
            return parseTrpcResponse<KillTaskResult>(json);
          },
        });
        onOptimisticSettle?.();
        return { alreadyTerminated: result.alreadyTerminated };
      }}
    />
  );
}
