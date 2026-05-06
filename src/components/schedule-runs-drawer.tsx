"use client";

// P3-T8 — schedule run-history drawer. Side-sheet that opens off the
// `/schedules` page when the user clicks the "Runs" button on a row.
// Mirrors the dispatch-dialog pattern (Phase 2 T02): a per-row
// `<ScheduleRunsTrigger>` button broadcasts a custom event; this
// component (mounted once at the page level) listens for the event,
// fetches `schedules.runs` via the tRPC GET endpoint, and renders the
// last N task rows linking back to `/tasks/[id]`.
//
// Two named exports, mirroring `<DispatchDialog>`:
//   * `ScheduleRunsDrawerView` — pure props-driven markup. No hooks,
//     no fetch. Tested via `renderToStaticMarkup` across the state
//     matrix.
//   * `ScheduleRunsDrawer`     — wrapper that owns local state,
//     listens for the open event, drives the fetch, and exposes
//     `onClose`. The wrapper does not know about the URL builder
//     directly other than through the client helper from
//     `src/lib/schedule-runs-client.ts`.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { taskStatusBadge } from "@/src/lib/task-status";
import {
  ScheduleRunsError,
  buildScheduleRunsRequest,
  parseTrpcResponse,
} from "@/src/lib/schedule-runs-client";
import type { ScheduleRunRow, ScheduleRunsPage } from "@/src/server/dto";

export const OPEN_SCHEDULE_RUNS_EVENT = "bridge:open-schedule-runs";

export interface OpenScheduleRunsDetail {
  id: number;
  /** Optional pre-fill: shown in the drawer header before fetch resolves. */
  name?: string;
}

export type ScheduleRunsStatus =
  | "closed"
  | "loading"
  | "ready"
  | "empty"
  | "error";

export interface ScheduleRunsDrawerViewProps {
  open: boolean;
  status: ScheduleRunsStatus;
  /** Header label — schedule name (or pre-fill while fetch in flight). */
  scheduleName: string | null;
  /** Header sub-label — agent the schedule dispatches against. */
  agentName: string | null;
  items: ScheduleRunRow[];
  errorCode: string | null;
  errorMessage: string | null;
  onClose?: () => void;
}

function formatCost(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toFixed(4)}`;
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatTimestamp(value: string | null): string {
  if (value === null || value.length === 0) return "—";
  return value;
}

export function ScheduleRunsDrawerView(props: ScheduleRunsDrawerViewProps) {
  if (!props.open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-runs-drawer-title"
      data-testid="schedule-runs-drawer"
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={(e) => {
        // Click on the dimmed backdrop closes the drawer; clicks
        // inside the panel bubble up but the panel stops them.
        if (e.target === e.currentTarget) props.onClose?.();
      }}
    >
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-2 border-b border-[hsl(var(--border))] px-4 py-3">
          <div className="min-w-0">
            <h2
              id="schedule-runs-drawer-title"
              className="truncate text-base font-semibold tracking-tight"
            >
              Runs · {props.scheduleName ?? "schedule"}
            </h2>
            {props.agentName ? (
              <p className="mt-0.5 truncate text-xs text-[hsl(var(--muted-foreground))]">
                Agent: <span className="font-mono">{props.agentName}</span>
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close runs drawer"
            className="rounded-md px-2 py-1 text-sm text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {props.status === "loading" ? (
            <p
              data-testid="schedule-runs-loading"
              className="text-sm text-[hsl(var(--muted-foreground))]"
            >
              Loading runs…
            </p>
          ) : null}

          {props.status === "error" ? (
            <div
              data-testid="schedule-runs-error"
              role="status"
              aria-live="polite"
              className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-300"
            >
              <p className="font-mono text-xs">
                {props.errorCode ?? "INTERNAL_SERVER_ERROR"}
              </p>
              <p className="mt-1">{props.errorMessage ?? "request failed"}</p>
              <div className="mt-2 flex justify-end">
                <Button variant="outline" size="sm" type="button" onClick={props.onClose}>
                  Close
                </Button>
              </div>
            </div>
          ) : null}

          {props.status === "empty" ? (
            <p
              data-testid="schedule-runs-empty"
              className="text-sm text-[hsl(var(--muted-foreground))]"
            >
              No runs yet — this schedule hasn't fired.
            </p>
          ) : null}

          {props.status === "ready" ? (
            <ul
              data-testid="schedule-runs-list"
              className="divide-y divide-[hsl(var(--border))]"
            >
              {props.items.map((run) => {
                const badge = taskStatusBadge(run.status);
                return (
                  <li
                    key={run.id}
                    data-testid="schedule-run-row"
                    className="flex items-start justify-between gap-3 py-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <Link
                        href={`/tasks/${run.id}`}
                        className="font-mono text-sm hover:underline"
                      >
                        #{run.id}
                      </Link>
                      <div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        <span className="font-mono">
                          {formatTimestamp(run.createdAt)}
                        </span>
                      </div>
                    </div>
                    <div className="text-right text-xs text-[hsl(var(--muted-foreground))]">
                      <p className="font-mono">{formatCost(run.costUsd)}</p>
                      <p className="font-mono">
                        {formatDuration(run.durationMs)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

export function ScheduleRunsDrawer() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ScheduleRunsStatus>("closed");
  const [scheduleId, setScheduleId] = useState<number | null>(null);
  const [scheduleName, setScheduleName] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [items, setItems] = useState<ScheduleRunRow[]>([]);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const closeDrawer = useCallback(() => {
    setOpen(false);
    setStatus("closed");
    setScheduleId(null);
    setScheduleName(null);
    setAgentName(null);
    setItems([]);
    setErrorCode(null);
    setErrorMessage(null);
  }, []);

  const fetchRuns = useCallback(async (id: number) => {
    setStatus("loading");
    setItems([]);
    setErrorCode(null);
    setErrorMessage(null);
    try {
      const { url, init } = buildScheduleRunsRequest({ id });
      const res = await fetch(url, init);
      const json: unknown = await res.json();
      const data = parseTrpcResponse<ScheduleRunsPage>(json);
      setScheduleName(data.scheduleName);
      setAgentName(data.agentName);
      setItems(data.items);
      setStatus(data.items.length === 0 ? "empty" : "ready");
    } catch (err) {
      const e =
        err instanceof ScheduleRunsError
          ? err
          : new ScheduleRunsError("INTERNAL_SERVER_ERROR", String(err));
      setErrorCode(e.code);
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<OpenScheduleRunsDetail>).detail;
      if (!detail || typeof detail.id !== "number") return;
      setOpen(true);
      setScheduleId(detail.id);
      setScheduleName(detail.name ?? null);
      setAgentName(null);
      void fetchRuns(detail.id);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDrawer();
    }
    window.addEventListener(OPEN_SCHEDULE_RUNS_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_SCHEDULE_RUNS_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, [fetchRuns, closeDrawer]);

  // Pin the in-flight schedule id on the wrapper for easier debugging
  // / Playwright assertions; not user-visible.
  void scheduleId;

  return (
    <ScheduleRunsDrawerView
      open={open}
      status={status}
      scheduleName={scheduleName}
      agentName={agentName}
      items={items}
      errorCode={errorCode}
      errorMessage={errorMessage}
      onClose={closeDrawer}
    />
  );
}

export interface ScheduleRunsTriggerProps {
  scheduleId: number;
  scheduleName: string;
}

/**
 * Small "Runs" button rendered in the per-row actions column on
 * `/schedules`. Decoupled from `<ScheduleRunsDrawer>` — clicking
 * dispatches the open event with `{ id, name }` so the drawer (mounted
 * once at the page level) opens. Same pathway as `<DispatchTrigger>`.
 */
export function ScheduleRunsTrigger(props: ScheduleRunsTriggerProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="schedule-runs-trigger"
      title={`View runs for ${props.scheduleName}`}
      className="px-2"
      onClick={() => {
        window.dispatchEvent(
          new CustomEvent<OpenScheduleRunsDetail>(OPEN_SCHEDULE_RUNS_EVENT, {
            detail: { id: props.scheduleId, name: props.scheduleName },
          }),
        );
      }}
    >
      Runs
    </Button>
  );
}
