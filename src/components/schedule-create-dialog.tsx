"use client";

// P3-T6 — schedule-create dialog. Opens from the "New schedule" button
// on `/schedules` (mounted alongside the page header). On submit,
// calls the tRPC mutation `schedules.add` and surfaces the daemon-
// assigned `id`. The user is expected to refresh the table (the page
// polls every N seconds; we also offer "Add another" + "Dismiss"
// actions that close the dialog).
//
// Two named exports:
//   * `ScheduleCreateDialogView` — pure props-driven markup; no
//     hooks, no event listeners. Tests render this with
//     `renderToStaticMarkup` across the full state matrix.
//   * `ScheduleCreateDialog` — the wrapper that owns local state, the
//     lazy agents fetch, and the submit fetch.
//
// The trigger lives in `<ScheduleCreateTrigger>`; both controls share
// an open-state authority via the `bridge:open-schedule-create` custom
// event, matching the dispatch dialog's pattern from Phase 2 T02 +
// the start-loop dialog from P3-T3.

import { useCallback, useEffect, useRef, useState } from "react";

import type { Agent, ScheduleCostForecast } from "@/src/server/dto";
import { Button } from "@/src/components/ui/button";
import {
  AGENTS_LIST_URL,
  DispatchError,
  buildAgentsListRequest,
  parseTrpcResponse as parseAgentsResponse,
  readCsrfTokenFromCookie,
} from "@/src/lib/dispatch-client";
import {
  ScheduleAddError,
  buildCostForecastRequest,
  buildScheduleAddRequest,
  parseTrpcResponse as parseScheduleAddResponse,
  type ScheduleAddInput,
} from "@/src/lib/schedule-add-client";
import { formatUsd } from "@/src/lib/cost-forecast";
import {
  CronPicker,
  type CronPickerOnChange,
} from "@/src/components/cron-picker";

export type ScheduleCreateStatus =
  | "loading"
  | "idle"
  | "submitting"
  | "success"
  | "error";

export const OPEN_SCHEDULE_CREATE_EVENT = "bridge:open-schedule-create";

export interface ScheduleCreateDialogViewProps {
  open: boolean;
  status: ScheduleCreateStatus;
  agents: Agent[];
  agentName: string;
  name: string;
  prompt: string;
  cronValid: boolean;
  cronMessage: string | null;
  channelChatId: string;
  completedScheduleId: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  csrfMissing: boolean;
  /**
   * P3-T9 — most-recent forecast result for the current
   * (agent, cadence) pair. `null` before the first fetch lands.
   */
  forecast: ScheduleCostForecast | null;
  /** P3-T9 — true when an in-flight forecast fetch hasn't resolved yet. */
  forecastLoading: boolean;
  onAgentChange?: (value: string) => void;
  onNameChange?: (value: string) => void;
  onPromptChange?: (value: string) => void;
  onChannelChatIdChange?: (value: string) => void;
  onSubmit?: () => void;
  onClose?: () => void;
  onReset?: () => void;
  /** Slot for the cron picker. The wrapper injects `<CronPicker>`. */
  cronPickerSlot?: React.ReactNode;
}

/**
 * P3-T9 — render the inline forecast block. Pure: no hooks. The view
 * decides what copy to show based on the forecast flags; the helper
 * `formatUsd` handles null / non-finite values uniformly.
 */
function CostForecastBlock({
  forecast,
  loading,
}: {
  forecast: ScheduleCostForecast | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <p
        className="text-xs text-[hsl(var(--muted-foreground))]"
        data-testid="cost-forecast-loading"
      >
        Computing forecast…
      </p>
    );
  }
  if (forecast === null) return null;
  if (forecast.cadenceUnresolved) {
    return (
      <p
        className="text-xs text-[hsl(var(--muted-foreground))]"
        data-testid="cost-forecast-unresolved"
      >
        Forecast unavailable for this cadence.
      </p>
    );
  }
  if (forecast.insufficientHistory) {
    return (
      <div className="space-y-0.5" data-testid="cost-forecast-insufficient">
        <p className="text-xs text-[hsl(var(--foreground))]">
          Insufficient history — first run will calibrate forecast.
        </p>
        <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
          ({forecast.runsPerMonth.toLocaleString()} runs / month at this cadence)
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-0.5" data-testid="cost-forecast-estimate">
      <p className="text-xs text-[hsl(var(--foreground))]">
        Estimated spend:{" "}
        <span className="font-mono font-semibold">
          {formatUsd(forecast.monthlyEstimateUsd)}
        </span>{" "}
        / month.
      </p>
      <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
        Likely range {formatUsd(forecast.monthlyLowUsd)} –{" "}
        {formatUsd(forecast.monthlyHighUsd)} (based on {forecast.sample}{" "}
        {forecast.sample === 1 ? "sample" : "samples"}).
      </p>
    </div>
  );
}

function isFormValid(props: ScheduleCreateDialogViewProps): boolean {
  if (props.agentName.length === 0) return false;
  if (props.prompt.trim().length === 0) return false;
  if (props.prompt.length > 32_000) return false;
  if (!props.cronValid) return false;
  if (props.name.length > 128) return false;
  if (props.channelChatId.length > 128) return false;
  return true;
}

export function ScheduleCreateDialogView(props: ScheduleCreateDialogViewProps) {
  if (!props.open) return null;

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
      aria-labelledby="schedule-create-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-2xl rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-xl">
        <header className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-4 py-3">
          <h2
            id="schedule-create-dialog-title"
            className="text-base font-semibold tracking-tight"
          >
            New schedule
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close schedule create dialog"
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

        {props.status === "success" && props.completedScheduleId !== null ? (
          <div className="space-y-4 px-4 py-6">
            <p className="text-sm">Schedule created. Daemon assigned id:</p>
            <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2">
              <span className="font-mono text-base font-semibold text-[hsl(var(--foreground))]">
                #{props.completedScheduleId}
              </span>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" type="button" onClick={props.onClose}>
                Dismiss
              </Button>
              <Button type="button" onClick={props.onReset}>
                Add another
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
                  Name (optional)
                </span>
                <input
                  type="text"
                  name="name"
                  value={props.name}
                  onChange={(e) => props.onNameChange?.(e.target.value)}
                  maxLength={128}
                  placeholder="(daemon auto-generates)"
                  className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[hsl(var(--muted-foreground))]">Prompt</span>
              <textarea
                name="prompt"
                value={props.prompt}
                onChange={(e) => props.onPromptChange?.(e.target.value)}
                rows={4}
                maxLength={32_000}
                placeholder="What should the agent do on each run?"
                className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-2 font-mono text-sm"
              />
            </label>

            {props.cronPickerSlot ?? null}

            <CostForecastBlock
              forecast={props.forecast}
              loading={props.forecastLoading}
            />

            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[hsl(var(--muted-foreground))]">
                Telegram chat id (optional)
              </span>
              <input
                type="text"
                name="channelChatId"
                value={props.channelChatId}
                onChange={(e) => props.onChannelChatIdChange?.(e.target.value)}
                maxLength={128}
                placeholder="(no Telegram routing)"
                className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
              />
            </label>

            {props.csrfMissing ? (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                Your session expired — reload the page to continue creating
                schedules.
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
                {props.status === "submitting" ? "Creating…" : "Create schedule"}
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

export function ScheduleCreateDialog() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ScheduleCreateStatus>("loading");
  const [agents, setAgents] = useState<Agent[]>(AGENTS_CACHE.cachedAgents ?? []);
  const [agentName, setAgentName] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [channelChatId, setChannelChatId] = useState("");
  const [cron, setCron] = useState<CronPickerOnChange>({
    cronExpr: "0 * * * *",
    intervalMinutes: 60,
    valid: true,
    message: null,
    nextFires: [],
  });
  const [completedScheduleId, setCompletedScheduleId] = useState<number | null>(
    null,
  );
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [csrfMissing, setCsrfMissing] = useState(false);
  const [forecast, setForecast] = useState<ScheduleCostForecast | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  // Race guard: a slow forecast fetch must not clobber a newer one
  // (the user may flip presets faster than the network round-trip).
  const forecastTokenRef = useRef(0);

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
    setName("");
    setPrompt("");
    setChannelChatId("");
    setCompletedScheduleId(null);
    setErrorCode(null);
    setErrorMessage(null);
  }, []);

  const submit = useCallback(async () => {
    const csrfToken = readCsrfTokenFromCookie(document.cookie);
    if (csrfToken === null) {
      setCsrfMissing(true);
      return;
    }
    if (!cron.valid || cron.intervalMinutes === null) {
      // Defensive: the form is supposed to disable submit when invalid;
      // bail without an MCP round-trip if we get here.
      return;
    }
    setStatus("submitting");
    setErrorCode(null);
    setErrorMessage(null);
    try {
      const input: ScheduleAddInput = {
        agentName,
        prompt,
        intervalMinutes: cron.intervalMinutes,
      };
      if (name.trim().length > 0) input.name = name.trim();
      if (cron.cronExpr !== null) input.cronExpr = cron.cronExpr;
      if (channelChatId.trim().length > 0) {
        input.channelChatId = channelChatId.trim();
      }
      const { url, init } = buildScheduleAddRequest(input, csrfToken);
      const res = await fetch(url, init);
      const json: unknown = await res.json();
      const data = parseScheduleAddResponse<{ id: number }>(json);
      setCompletedScheduleId(data.id);
      setStatus("success");
    } catch (err) {
      const e =
        err instanceof ScheduleAddError
          ? err
          : new ScheduleAddError("INTERNAL_SERVER_ERROR", String(err));
      setErrorCode(e.code);
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, [agentName, prompt, name, channelChatId, cron]);

  useEffect(() => {
    function onOpenEvent() {
      openDialog();
    }
    window.addEventListener(OPEN_SCHEDULE_CREATE_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener(OPEN_SCHEDULE_CREATE_EVENT, onOpenEvent);
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

  // P3-T9 — refresh the cost forecast whenever the (agent, cadence)
  // pair changes. The cron picker emits a new `cron` reference on
  // every keystroke; React's effect-batching keeps us from issuing
  // more than one fetch per render. The race-guard token discards
  // out-of-order responses (the user may flip presets faster than
  // the round-trip).
  useEffect(() => {
    if (!open) return;
    if (agentName.length === 0) return;
    if (!cron.valid || cron.intervalMinutes === null) {
      setForecast(null);
      setForecastLoading(false);
      return;
    }
    const token = ++forecastTokenRef.current;
    setForecastLoading(true);
    const fetchInput: {
      agent: string;
      intervalMinutes: number;
      cronExpr?: string;
    } = {
      agent: agentName,
      intervalMinutes: cron.intervalMinutes,
    };
    if (cron.cronExpr !== null) fetchInput.cronExpr = cron.cronExpr;
    const { url, init } = buildCostForecastRequest(fetchInput);
    fetch(url, init)
      .then((res) => res.json())
      .then((json: unknown) => {
        if (token !== forecastTokenRef.current) return;
        try {
          const data = parseScheduleAddResponse<ScheduleCostForecast>(json);
          setForecast(data);
        } catch {
          setForecast(null);
        }
        setForecastLoading(false);
      })
      .catch(() => {
        if (token !== forecastTokenRef.current) return;
        setForecast(null);
        setForecastLoading(false);
      });
  }, [open, agentName, cron.intervalMinutes, cron.cronExpr, cron.valid]);

  return (
    <ScheduleCreateDialogView
      open={open}
      status={status}
      agents={agents}
      agentName={agentName}
      name={name}
      prompt={prompt}
      cronValid={cron.valid}
      cronMessage={cron.message}
      channelChatId={channelChatId}
      completedScheduleId={completedScheduleId}
      errorCode={errorCode}
      errorMessage={errorMessage}
      csrfMissing={csrfMissing}
      forecast={forecast}
      forecastLoading={forecastLoading}
      onAgentChange={setAgentName}
      onNameChange={setName}
      onPromptChange={setPrompt}
      onChannelChatIdChange={setChannelChatId}
      onSubmit={() => void submit()}
      onClose={closeDialog}
      onReset={resetForm}
      cronPickerSlot={<CronPicker onChange={setCron} />}
    />
  );
}

export function ScheduleCreateTrigger() {
  return (
    <Button
      type="button"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(OPEN_SCHEDULE_CREATE_EVENT));
      }}
      aria-label="Open schedule-create dialog"
    >
      New schedule
    </Button>
  );
}

/** Test-only — clears the in-memory agents cache used by `ScheduleCreateDialog`. */
export function __resetScheduleCreateAgentsCache(): void {
  delete AGENTS_CACHE.cachedAgents;
}

/** Re-export for use by Playwright + reuse from /schedules page. */
export { AGENTS_LIST_URL };
