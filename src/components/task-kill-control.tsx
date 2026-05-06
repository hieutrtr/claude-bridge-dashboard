"use client";

// P2-T10 — client island combining the task status `<Badge>` and the
// `<KillTaskButton>` so the UI can render an *optimistic* killed state
// the moment the user confirms the danger dialog. The wrapper owns
// one piece of mutable state — `optimisticStatus` — and threads
// `onOptimisticBegin` / `onOptimisticSettle` / `onOptimisticRollback`
// through `<KillTaskButton>`. The button calls those hooks from inside
// `runOptimistic` (`src/lib/optimistic.ts`) around the `tasks.kill`
// mutation.
//
// State priority for the rendered badge + button visibility:
//
//   1. `optimisticStatus === "killing"` → in-flight, badge "Killing…",
//      kill button hidden (clicking again would double-fire).
//   2. `optimisticStatus === "killed"`  → server resolved or daemon
//      already terminal; badge "Killed", button hidden.
//   3. fallback → render `serverStatus` (the value the server
//      component initially passed, frozen for the lifetime of the
//      page render).
//
// On rollback the wrapper resets `optimisticStatus` to null, so the
// button reappears and the user can retry. The error banner is shown
// inside the `<DangerConfirm>` itself (existing T11 behavior).

import { useCallback, useState } from "react";

import { Badge } from "@/src/components/ui/badge";
import { KillTaskButton } from "@/src/components/kill-task-button";
import { taskStatusBadge } from "@/src/lib/task-status";

export type OptimisticKillStatus = "killing" | "killed" | null;

const KILLING_BADGE = { label: "Killing…", variant: "running" as const };
const KILLED_BADGE = { label: "Killed", variant: "error" as const };
const TERMINAL_SERVER_STATUSES = new Set(["done", "failed", "killed"]);

export interface TaskKillControlViewProps {
  taskId: number;
  agentName: string | null;
  serverStatus: string | null;
  optimisticStatus: OptimisticKillStatus;
  /**
   * Synchronous hook called the moment the user confirms the kill
   * dialog, before the network round-trip starts. Wired by
   * `<TaskKillControl>` to `setOptimisticStatus("killing")`.
   */
  onOptimisticBegin?: () => void;
  /** Hook called once the kill mutation resolves successfully. */
  onOptimisticSettle?: () => void;
  /** Hook called when the kill mutation rejects — used to rollback. */
  onOptimisticRollback?: () => void;
}

export function TaskKillControlView(props: TaskKillControlViewProps) {
  const visualBadge =
    props.optimisticStatus === "killing"
      ? KILLING_BADGE
      : props.optimisticStatus === "killed"
        ? KILLED_BADGE
        : taskStatusBadge(props.serverStatus);

  // The Kill button hides once optimistic flips to "killing" or
  // "killed" — the underlying `<KillTaskButton>` also short-circuits
  // when serverStatus is terminal, but optimistic must override even
  // when the server-rendered status still says running.
  const showKill =
    props.agentName !== null &&
    props.optimisticStatus === null &&
    !TERMINAL_SERVER_STATUSES.has(props.serverStatus ?? "");

  return (
    <div className="flex items-center gap-2">
      <Badge variant={visualBadge.variant}>{visualBadge.label}</Badge>
      {showKill ? (
        <KillTaskButton
          taskId={props.taskId}
          agentName={props.agentName}
          status={props.serverStatus}
          onOptimisticBegin={props.onOptimisticBegin}
          onOptimisticSettle={props.onOptimisticSettle}
          onOptimisticRollback={props.onOptimisticRollback}
        />
      ) : null}
    </div>
  );
}

export interface TaskKillControlProps {
  taskId: number;
  agentName: string | null;
  serverStatus: string | null;
}

export function TaskKillControl(props: TaskKillControlProps) {
  const [optimisticStatus, setOptimisticStatus] =
    useState<OptimisticKillStatus>(null);

  const onOptimisticBegin = useCallback(() => {
    setOptimisticStatus("killing");
  }, []);
  const onOptimisticSettle = useCallback(() => {
    setOptimisticStatus("killed");
  }, []);
  const onOptimisticRollback = useCallback(() => {
    setOptimisticStatus(null);
  }, []);

  return (
    <TaskKillControlView
      taskId={props.taskId}
      agentName={props.agentName}
      serverStatus={props.serverStatus}
      optimisticStatus={optimisticStatus}
      onOptimisticBegin={onOptimisticBegin}
      onOptimisticSettle={onOptimisticSettle}
      onOptimisticRollback={onOptimisticRollback}
    />
  );
}
