"use client";

// P2-T11 — kill-task button on `/tasks/[id]`. Thin client wrapper over
// `<DangerConfirm>` (the reusable confirmation primitive). The server
// procedure (`tasks.kill`) shipped in T03; this component is the UI
// seam.
//
// Render policy:
//   * orphan task (`agentName === null`) — no kill target, render nothing.
//   * task in a terminal status (done / failed / killed) — server would
//     return `alreadyTerminated:true` immediately; surface a no-op by
//     rendering nothing.
//   * everything else (running, pending, queued, unknown) — render
//     the Kill trigger; the server handles edge cases.

import { Button } from "@/src/components/ui/button";
import { DangerConfirm } from "@/src/components/danger-confirm";
import {
  DispatchError,
  buildKillTaskRequest,
  parseTrpcResponse,
  readCsrfTokenFromCookie,
  type KillTaskResult,
} from "@/src/lib/danger-confirm-client";

interface Props {
  taskId: number;
  agentName: string | null;
  status: string | null;
}

const TERMINAL_STATUSES = new Set(["done", "failed", "killed"]);

export function KillTaskButton({ taskId, agentName, status }: Props) {
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
        const { url, init } = buildKillTaskRequest({ id: taskId }, csrf);
        const res = await fetch(url, init);
        const json: unknown = await res.json();
        const data = parseTrpcResponse<KillTaskResult>(json);
        return { alreadyTerminated: data.alreadyTerminated };
      }}
    />
  );
}
