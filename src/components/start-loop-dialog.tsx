"use client";

// P3-T3 — start-loop dialog. Opens from the "Start loop" button on
// `/loops` (mounted alongside the page header). On submit, calls the
// tRPC mutation `loops.start` and surfaces the returned `loopId` as a
// `<Link>` to `/loops/[loopId]`.
//
// Two named exports:
//   * `StartLoopDialogView` — pure props-driven markup; no hooks, no
//     event listeners. Tests render this with `renderToStaticMarkup`
//     across the full state matrix.
//   * `StartLoopDialog` — the wrapper that owns local state, the
//     lazy agents fetch, and the submit fetch.
//
// The trigger lives in `<StartLoopTrigger>`; both controls share an
// open-state authority via the `bridge:open-start-loop` custom event,
// matching the dispatch dialog's pattern from Phase 2 T02.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import type { Agent } from "@/src/server/dto";
import { Button } from "@/src/components/ui/button";
import {
  AGENTS_LIST_URL,
  DispatchError,
  buildAgentsListRequest,
  parseTrpcResponse as parseAgentsResponse,
  readCsrfTokenFromCookie,
} from "@/src/lib/dispatch-client";
import {
  LoopStartError,
  buildLoopStartRequest,
  composeDoneWhen,
  DONE_WHEN_PRESETS,
  isValidDoneWhen,
  parseTrpcResponse as parseLoopStartResponse,
  type LoopStartInput,
} from "@/src/lib/loop-start-client";

export type StartLoopStatus =
  | "loading"
  | "idle"
  | "submitting"
  | "success"
  | "error";

export type DoneWhenPrefix =
  | "command"
  | "file_exists"
  | "file_contains"
  | "llm_judge"
  | "manual";

export const OPEN_START_LOOP_EVENT = "bridge:open-start-loop";

export interface StartLoopDialogViewProps {
  open: boolean;
  status: StartLoopStatus;
  agents: Agent[];
  agentName: string;
  goal: string;
  doneWhenPrefix: DoneWhenPrefix;
  doneWhenValue: string;
  maxIterations: string;
  maxCostUsd: string;
  passThreshold: string;
  loopType: "bridge" | "agent" | "auto";
  planFirst: boolean;
  completedLoopId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  csrfMissing: boolean;
  onAgentChange?: (value: string) => void;
  onGoalChange?: (value: string) => void;
  onDoneWhenPrefixChange?: (value: DoneWhenPrefix) => void;
  onDoneWhenValueChange?: (value: string) => void;
  onMaxIterationsChange?: (value: string) => void;
  onMaxCostUsdChange?: (value: string) => void;
  onPassThresholdChange?: (value: string) => void;
  onLoopTypeChange?: (value: "bridge" | "agent" | "auto") => void;
  onPlanFirstChange?: (value: boolean) => void;
  onSubmit?: () => void;
  onClose?: () => void;
  onReset?: () => void;
}

function donePrefixHint(prefix: DoneWhenPrefix): string {
  return DONE_WHEN_PRESETS.find((p) => p.value === prefix)?.hint ?? "";
}

function isFormValid(props: StartLoopDialogViewProps): boolean {
  if (props.agentName.length === 0) return false;
  if (props.goal.trim().length === 0) return false;
  // doneWhen: composed value must satisfy the server regex. For non-
  // manual prefixes we additionally require the value to be non-empty
  // (manual: bare-colon form is allowed by the daemon).
  const composed = composeDoneWhen(props.doneWhenPrefix, props.doneWhenValue);
  if (!isValidDoneWhen(composed)) return false;
  if (
    props.doneWhenPrefix !== "manual" &&
    props.doneWhenValue.trim().length === 0
  )
    return false;
  // Numeric fields — empty string is allowed (means "send default to
  // daemon"); a non-empty string must parse to a positive number.
  if (props.maxIterations.length > 0) {
    const n = Number(props.maxIterations);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 200) return false;
  }
  if (props.maxCostUsd.length > 0) {
    const n = Number(props.maxCostUsd);
    if (!Number.isFinite(n) || n <= 0 || n > 10_000) return false;
  }
  if (props.passThreshold.length > 0) {
    const n = Number(props.passThreshold);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 10) return false;
  }
  return true;
}

export function StartLoopDialogView(props: StartLoopDialogViewProps) {
  if (!props.open) return null;

  const composedDoneWhen = composeDoneWhen(
    props.doneWhenPrefix,
    props.doneWhenValue,
  );
  const formValid = isFormValid(props);
  const submitDisabled =
    props.status === "submitting" ||
    props.status === "loading" ||
    props.csrfMissing ||
    props.agents.length === 0 ||
    !formValid;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="start-loop-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-2xl rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-xl">
        <header className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-4 py-3">
          <h2
            id="start-loop-dialog-title"
            className="text-base font-semibold tracking-tight"
          >
            Start loop
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close start loop dialog"
            className="rounded-md px-2 py-1 text-sm text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
          >
            ✕
          </button>
        </header>

        {props.status === "loading" ? (
          <div className="px-4 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
            Loading agents…
          </div>
        ) : null}

        {props.status === "success" && props.completedLoopId !== null ? (
          <div className="space-y-4 px-4 py-6">
            <p className="text-sm">Loop started. Daemon assigned id:</p>
            <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2">
              <Link
                href={`/loops/${encodeURIComponent(props.completedLoopId)}`}
                className="font-mono text-base font-semibold text-[hsl(var(--foreground))] hover:underline"
              >
                Loop {props.completedLoopId}
              </Link>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" type="button" onClick={props.onClose}>
                Dismiss
              </Button>
              <Button type="button" onClick={props.onReset}>
                Start another
              </Button>
            </div>
          </div>
        ) : null}

        {(props.status === "idle" ||
          props.status === "submitting" ||
          props.status === "error") &&
        props.agents.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
            No agents available. Register one with{" "}
            <code className="font-mono">bridge_create_agent</code> first.
          </div>
        ) : null}

        {(props.status === "idle" ||
          props.status === "submitting" ||
          props.status === "error") &&
        props.agents.length > 0 ? (
          <form
            className="space-y-4 px-4 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              props.onSubmit?.();
            }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-[hsl(var(--muted-foreground))]">Agent</span>
                <select
                  name="agentName"
                  value={props.agentName}
                  onChange={(e) => props.onAgentChange?.(e.target.value)}
                  className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
                >
                  {props.agents.map((a) => (
                    <option key={`${a.name}::${a.projectDir}`} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-[hsl(var(--muted-foreground))]">
                  Loop type
                </span>
                <select
                  name="loopType"
                  value={props.loopType}
                  onChange={(e) =>
                    props.onLoopTypeChange?.(
                      e.target.value as "bridge" | "agent" | "auto",
                    )
                  }
                  className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
                >
                  <option value="bridge">bridge — bot orchestrates</option>
                  <option value="agent">agent — agent-driven loop</option>
                  <option value="auto">auto — daemon picks</option>
                </select>
              </label>
            </div>

            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[hsl(var(--muted-foreground))]">Goal</span>
              <textarea
                name="goal"
                value={props.goal}
                onChange={(e) => props.onGoalChange?.(e.target.value)}
                rows={4}
                maxLength={32_000}
                placeholder="What should the loop accomplish?"
                className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-2 font-mono text-sm"
              />
            </label>

            <fieldset className="grid grid-cols-1 gap-2 rounded-md border border-[hsl(var(--border))] p-3">
              <legend className="px-1 text-xs text-[hsl(var(--muted-foreground))]">
                Done condition
              </legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-[hsl(var(--muted-foreground))]">
                    Evaluator
                  </span>
                  <select
                    name="doneWhenPrefix"
                    value={props.doneWhenPrefix}
                    onChange={(e) =>
                      props.onDoneWhenPrefixChange?.(
                        e.target.value as DoneWhenPrefix,
                      )
                    }
                    className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
                  >
                    {DONE_WHEN_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="col-span-1 flex flex-col gap-1 text-xs sm:col-span-2">
                  <span className="text-[hsl(var(--muted-foreground))]">
                    Value{props.doneWhenPrefix === "manual" ? " (optional)" : ""}
                  </span>
                  <input
                    type="text"
                    name="doneWhenValue"
                    value={props.doneWhenValue}
                    onChange={(e) =>
                      props.onDoneWhenValueChange?.(e.target.value)
                    }
                    placeholder={
                      props.doneWhenPrefix === "command"
                        ? "bun test"
                        : props.doneWhenPrefix === "file_exists"
                        ? "/tmp/done"
                        : props.doneWhenPrefix === "file_contains"
                        ? "README.md OK"
                        : props.doneWhenPrefix === "llm_judge"
                        ? "tests pass"
                        : "(optional rationale)"
                    }
                    className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
                  />
                </label>
              </div>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
                {donePrefixHint(props.doneWhenPrefix)}
              </p>
              <p className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
                Server input: <span className="text-[hsl(var(--foreground))]">{composedDoneWhen}</span>
              </p>
            </fieldset>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-[hsl(var(--muted-foreground))]">
                  Max iterations
                </span>
                <input
                  type="number"
                  name="maxIterations"
                  value={props.maxIterations}
                  onChange={(e) => props.onMaxIterationsChange?.(e.target.value)}
                  min={1}
                  max={200}
                  step={1}
                  placeholder="10"
                  className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-[hsl(var(--muted-foreground))]">
                  Max cost (USD)
                </span>
                <input
                  type="number"
                  name="maxCostUsd"
                  value={props.maxCostUsd}
                  onChange={(e) => props.onMaxCostUsdChange?.(e.target.value)}
                  min={0.0001}
                  step={0.01}
                  placeholder="—"
                  className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-[hsl(var(--muted-foreground))]">
                  Pass threshold
                </span>
                <input
                  type="number"
                  name="passThreshold"
                  value={props.passThreshold}
                  onChange={(e) => props.onPassThresholdChange?.(e.target.value)}
                  min={1}
                  max={10}
                  step={1}
                  placeholder="1"
                  className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                name="planFirst"
                checked={props.planFirst}
                onChange={(e) => props.onPlanFirstChange?.(e.target.checked)}
                className="h-4 w-4 rounded border border-[hsl(var(--border))]"
              />
              <span>
                Plan-first — iter 1 produces a JSON plan, iters 2..N+1 execute one
                sub-task each.
              </span>
            </label>

            {props.csrfMissing ? (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                Your session expired — reload the page to continue starting loops.
              </p>
            ) : null}

            {props.status === "error" ? (
              <p className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                <span className="font-mono font-semibold">{props.errorCode}</span>
                {" — "}
                {props.errorMessage ?? "request failed"}
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" type="button" onClick={props.onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitDisabled}>
                {props.status === "submitting" ? "Starting…" : "Start loop"}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}

interface AgentsListEnvelopeWindow {
  cachedAgents?: Agent[];
}

const AGENTS_CACHE: AgentsListEnvelopeWindow = {};

export function StartLoopDialog() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StartLoopStatus>("loading");
  const [agents, setAgents] = useState<Agent[]>(AGENTS_CACHE.cachedAgents ?? []);
  const [agentName, setAgentName] = useState("");
  const [goal, setGoal] = useState("");
  const [doneWhenPrefix, setDoneWhenPrefix] = useState<DoneWhenPrefix>("manual");
  const [doneWhenValue, setDoneWhenValue] = useState("");
  const [maxIterations, setMaxIterations] = useState("");
  const [maxCostUsd, setMaxCostUsd] = useState("");
  const [passThreshold, setPassThreshold] = useState("");
  const [loopType, setLoopType] = useState<"bridge" | "agent" | "auto">("bridge");
  const [planFirst, setPlanFirst] = useState(true);
  const [completedLoopId, setCompletedLoopId] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [csrfMissing, setCsrfMissing] = useState(false);

  const ensureAgents = useCallback(async () => {
    if (AGENTS_CACHE.cachedAgents !== undefined) {
      setAgents(AGENTS_CACHE.cachedAgents);
      setStatus("idle");
      if (
        AGENTS_CACHE.cachedAgents.length > 0 &&
        agentName.length === 0
      ) {
        setAgentName(AGENTS_CACHE.cachedAgents[0]!.name);
      }
      return;
    }
    setStatus("loading");
    try {
      const { url, init } = buildAgentsListRequest();
      const res = await fetch(url, init);
      const json: unknown = await res.json();
      const data = parseAgentsResponse<Agent[]>(json);
      AGENTS_CACHE.cachedAgents = data;
      setAgents(data);
      if (data.length > 0 && agentName.length === 0) {
        setAgentName(data[0]!.name);
      }
      setStatus("idle");
    } catch (err) {
      const e =
        err instanceof DispatchError
          ? err
          : new DispatchError("INTERNAL_SERVER_ERROR", String(err));
      setErrorCode(e.code);
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, [agentName]);

  const openDialog = useCallback(() => {
    if (open) return;
    setOpen(true);
    setCsrfMissing(readCsrfTokenFromCookie(document.cookie) === null);
    void ensureAgents();
  }, [open, ensureAgents]);

  const closeDialog = useCallback(() => {
    setOpen(false);
  }, []);

  const resetForm = useCallback(() => {
    setStatus("idle");
    setGoal("");
    setDoneWhenPrefix("manual");
    setDoneWhenValue("");
    setMaxIterations("");
    setMaxCostUsd("");
    setPassThreshold("");
    setLoopType("bridge");
    setPlanFirst(true);
    setCompletedLoopId(null);
    setErrorCode(null);
    setErrorMessage(null);
  }, []);

  const submit = useCallback(async () => {
    const csrfToken = readCsrfTokenFromCookie(document.cookie);
    if (csrfToken === null) {
      setCsrfMissing(true);
      return;
    }
    setStatus("submitting");
    setErrorCode(null);
    setErrorMessage(null);
    try {
      const composed = composeDoneWhen(doneWhenPrefix, doneWhenValue);
      const input: LoopStartInput = {
        agentName,
        goal,
        doneWhen: composed,
        loopType,
        planFirst,
      };
      if (maxIterations.length > 0) {
        input.maxIterations = Number(maxIterations);
      }
      if (maxCostUsd.length > 0) {
        input.maxCostUsd = Number(maxCostUsd);
      }
      if (passThreshold.length > 0) {
        input.passThreshold = Number(passThreshold);
      }
      const { url, init } = buildLoopStartRequest(input, csrfToken);
      const res = await fetch(url, init);
      const json: unknown = await res.json();
      const data = parseLoopStartResponse<{ loopId: string }>(json);
      setCompletedLoopId(data.loopId);
      setStatus("success");
    } catch (err) {
      const e =
        err instanceof LoopStartError
          ? err
          : new LoopStartError("INTERNAL_SERVER_ERROR", String(err));
      setErrorCode(e.code);
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, [
    agentName,
    goal,
    doneWhenPrefix,
    doneWhenValue,
    maxIterations,
    maxCostUsd,
    passThreshold,
    loopType,
    planFirst,
  ]);

  useEffect(() => {
    function onOpenEvent() {
      openDialog();
    }
    window.addEventListener(OPEN_START_LOOP_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener(OPEN_START_LOOP_EVENT, onOpenEvent);
    };
  }, [openDialog]);

  useEffect(() => {
    if (agents.length === 0) return;
    if (agentName.length === 0) {
      setAgentName(agents[0]!.name);
      return;
    }
    if (!agents.some((a) => a.name === agentName)) {
      setAgentName(agents[0]!.name);
    }
  }, [agents, agentName]);

  return (
    <StartLoopDialogView
      open={open}
      status={status}
      agents={agents}
      agentName={agentName}
      goal={goal}
      doneWhenPrefix={doneWhenPrefix}
      doneWhenValue={doneWhenValue}
      maxIterations={maxIterations}
      maxCostUsd={maxCostUsd}
      passThreshold={passThreshold}
      loopType={loopType}
      planFirst={planFirst}
      completedLoopId={completedLoopId}
      errorCode={errorCode}
      errorMessage={errorMessage}
      csrfMissing={csrfMissing}
      onAgentChange={setAgentName}
      onGoalChange={setGoal}
      onDoneWhenPrefixChange={setDoneWhenPrefix}
      onDoneWhenValueChange={setDoneWhenValue}
      onMaxIterationsChange={setMaxIterations}
      onMaxCostUsdChange={setMaxCostUsd}
      onPassThresholdChange={setPassThreshold}
      onLoopTypeChange={setLoopType}
      onPlanFirstChange={setPlanFirst}
      onSubmit={() => void submit()}
      onClose={closeDialog}
      onReset={resetForm}
    />
  );
}

export function StartLoopTrigger() {
  return (
    <Button
      type="button"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(OPEN_START_LOOP_EVENT));
      }}
      aria-label="Open start-loop dialog"
    >
      Start loop
    </Button>
  );
}

/** Test-only — clears the in-memory agents cache used by `StartLoopDialog`. */
export function __resetStartLoopAgentsCache(): void {
  delete AGENTS_CACHE.cachedAgents;
}

/** Re-export for use by Playwright + reuse from /loops page. */
export { AGENTS_LIST_URL };
