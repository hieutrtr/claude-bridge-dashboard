"use client";

// P2-T02 — global dispatch dialog. Opens via ⌘K / Ctrl+K from anywhere
// in the authed shell and via a topbar button (`<DispatchTrigger>`).
// On submit, calls the tRPC mutation `tasks.dispatch` and surfaces the
// returned task id as a `<Link>` to /tasks/[id].
//
// Two named exports:
//   * `DispatchDialogView`  — pure props-driven markup; no hooks,
//     no event listeners. Tests render this with `renderToStaticMarkup`
//     across the full state matrix.
//   * `DispatchDialog`      — the wrapper that owns local state, the
//     ⌘K listener, the lazy agents fetch, and the submit fetch.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import type { Agent } from "@/src/server/dto";
import { Button } from "@/src/components/ui/button";
import {
  AGENTS_LIST_URL,
  DispatchError,
  buildAgentsListRequest,
  buildDispatchRequest,
  parseTrpcResponse,
  readCsrfTokenFromCookie,
} from "@/src/lib/dispatch-client";

export type DispatchStatus =
  | "loading"
  | "idle"
  | "submitting"
  | "success"
  | "error";

export const OPEN_DISPATCH_EVENT = "bridge:open-dispatch";

export interface DispatchDialogViewProps {
  open: boolean;
  status: DispatchStatus;
  agents: Agent[];
  agentName: string;
  prompt: string;
  model: string;
  completedTaskId: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  csrfMissing: boolean;
  onAgentChange?: (value: string) => void;
  onPromptChange?: (value: string) => void;
  onModelChange?: (value: string) => void;
  onSubmit?: () => void;
  onClose?: () => void;
  onReset?: () => void;
}

export function DispatchDialogView(props: DispatchDialogViewProps) {
  if (!props.open) {
    return null;
  }

  const submitDisabled =
    props.status === "submitting" ||
    props.status === "loading" ||
    props.csrfMissing ||
    props.agents.length === 0 ||
    props.prompt.trim().length === 0 ||
    props.agentName.length === 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dispatch-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-lg rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-xl">
        <header className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-4 py-3">
          <h2
            id="dispatch-dialog-title"
            className="text-base font-semibold tracking-tight"
          >
            Dispatch task
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close dispatch dialog"
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

        {props.status === "success" && props.completedTaskId !== null ? (
          <div className="space-y-4 px-4 py-6">
            <p className="text-sm">Dispatched. Daemon assigned task id:</p>
            <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2">
              <Link
                href={`/tasks/${props.completedTaskId}`}
                className="font-mono text-base font-semibold text-[hsl(var(--foreground))] hover:underline"
              >
                Task #{props.completedTaskId}
              </Link>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" type="button" onClick={props.onClose}>
                Dismiss
              </Button>
              <Button type="button" onClick={props.onReset}>
                Dispatch another
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
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[hsl(var(--muted-foreground))]">Agent</span>
              <select
                name="agentName"
                value={props.agentName}
                onChange={(e) => props.onAgentChange?.(e.target.value)}
                className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
              >
                {props.agents.map((a) => (
                  <option
                    key={`${a.name}::${a.projectDir}`}
                    value={a.name}
                  >
                    {a.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[hsl(var(--muted-foreground))]">
                Model (optional)
              </span>
              <input
                type="text"
                name="model"
                value={props.model}
                onChange={(e) => props.onModelChange?.(e.target.value)}
                placeholder="sonnet / opus / haiku — defaults to agent default"
                className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[hsl(var(--muted-foreground))]">Prompt</span>
              <textarea
                name="prompt"
                value={props.prompt}
                onChange={(e) => props.onPromptChange?.(e.target.value)}
                rows={6}
                maxLength={32_000}
                className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-2 font-mono text-sm"
              />
              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                Cost preview unavailable in Phase 2.
              </span>
            </label>

            {props.csrfMissing ? (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                Your session expired — reload the page to continue dispatching.
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
                {props.status === "submitting" ? "Dispatching…" : "Dispatch"}
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

export function DispatchDialog() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<DispatchStatus>("loading");
  const [agents, setAgents] = useState<Agent[]>(AGENTS_CACHE.cachedAgents ?? []);
  const [agentName, setAgentName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [completedTaskId, setCompletedTaskId] = useState<number | null>(null);
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
      const data = parseTrpcResponse<Agent[]>(json);
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
    setPrompt("");
    setModel("");
    setCompletedTaskId(null);
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
      const input = { agentName, prompt, ...(model.length > 0 ? { model } : {}) };
      const { url, init } = buildDispatchRequest(input, csrfToken);
      const res = await fetch(url, init);
      const json: unknown = await res.json();
      const data = parseTrpcResponse<{ taskId: number }>(json);
      setCompletedTaskId(data.taskId);
      setStatus("success");
    } catch (err) {
      const e =
        err instanceof DispatchError
          ? err
          : new DispatchError("INTERNAL_SERVER_ERROR", String(err));
      setErrorCode(e.code);
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, [agentName, prompt, model]);

  useEffect(() => {
    // P4-T05: ⌘K now opens the command palette, not this dialog. The
    // palette includes a "Dispatch task to agent…" command that fires
    // OPEN_DISPATCH_EVENT — preserving the same one-keystroke flow
    // through a single shared hotkey owner.
    function onOpenEvent() {
      openDialog();
    }
    window.addEventListener(OPEN_DISPATCH_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener(OPEN_DISPATCH_EVENT, onOpenEvent);
    };
  }, [openDialog]);

  // Keep the agentName aligned with the agents list once it loads.
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
    <DispatchDialogView
      open={open}
      status={status}
      agents={agents}
      agentName={agentName}
      prompt={prompt}
      model={model}
      completedTaskId={completedTaskId}
      errorCode={errorCode}
      errorMessage={errorMessage}
      csrfMissing={csrfMissing}
      onAgentChange={setAgentName}
      onPromptChange={setPrompt}
      onModelChange={setModel}
      onSubmit={() => void submit()}
      onClose={closeDialog}
      onReset={resetForm}
    />
  );
}

/** Test-only — clears the in-memory agents cache used by `DispatchDialog`. */
export function __resetDispatchAgentsCache(): void {
  delete AGENTS_CACHE.cachedAgents;
}

/** Re-export for use by `<DispatchTrigger>` consumers + Playwright. */
export { AGENTS_LIST_URL };
