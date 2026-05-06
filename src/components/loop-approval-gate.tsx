"use client";

// P3-T4 — Approve / Deny gate that renders **large** buttons at the
// top of `/loops/[loopId]` when `pending_approval=true`. Per the v1
// plan acceptance ("Allow/Deny lớn"), the buttons are visually
// dominant — a phone user gating a 30s-old loop should be able to
// land a thumb without zooming. Approve commits without further input;
// Deny opens a small inline reason form that submits to `loops.reject`.
//
// No DangerConfirm wrap — Phase 3 INDEX §"Mutation Phase 3 invariant
// checklist" T4 explicitly states approve/reject are NOT destructive
// (they advance the loop), only cancel is. A typo on "Approve" still
// requires a deliberate click; Deny's inline reason form is itself a
// gentle confirmation pause.
//
// Two named exports:
//   * `LoopApprovalGateView` — pure props-driven markup. No hooks,
//     no `document.cookie`. Tested with `renderToStaticMarkup`.
//   * `LoopApprovalGate`     — wrapper that owns local state, reads
//     CSRF from `document.cookie` once, drives the two fetches.
//
// On either success the wrapper calls `onResolved` so the page can
// refetch the loop and (almost certainly) drop the gate from the next
// render.

import { useCallback, useState } from "react";

import { Button } from "@/src/components/ui/button";
import {
  DispatchError,
  readCsrfTokenFromCookie,
} from "@/src/lib/dispatch-client";
import {
  LoopMutationError,
  buildLoopApproveRequest,
  buildLoopRejectRequest,
  parseTrpcResponse,
  type LoopGateResult,
} from "@/src/lib/loop-mutation-client";

export type LoopApprovalGateStatus =
  | "idle"
  | "submitting-approve"
  | "submitting-reject"
  | "denying"
  | "resolved"
  | "error";

export interface LoopApprovalGateViewProps {
  status: LoopApprovalGateStatus;
  reason: string;
  alreadyFinalized: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  csrfMissing: boolean;
  onApprove?: () => void;
  onOpenDeny?: () => void;
  onCancelDeny?: () => void;
  onSubmitReject?: () => void;
  onReasonChange?: (value: string) => void;
}

export function LoopApprovalGateView(props: LoopApprovalGateViewProps) {
  if (props.status === "resolved") {
    return (
      <section
        role="status"
        data-testid="loop-approval-resolved"
        className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-300"
      >
        {props.alreadyFinalized
          ? "Loop already finalized through another channel — gate dismissed."
          : "Decision recorded. Refreshing loop…"}
      </section>
    );
  }

  const submitting =
    props.status === "submitting-approve" ||
    props.status === "submitting-reject";
  const denyMode = props.status === "denying" || props.status === "submitting-reject";
  const reasonTooLong = props.reason.length > 1000;

  return (
    <section
      role="region"
      aria-label="Loop approval gate"
      data-testid="loop-approval-gate"
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-4 shadow-sm"
    >
      <header className="mb-3 flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-flex h-2 w-2 animate-pulse rounded-full bg-amber-400"
        />
        <h2 className="text-sm font-semibold text-amber-200">
          Awaiting your decision
        </h2>
      </header>
      <p className="mb-4 text-sm text-[hsl(var(--foreground))]">
        The loop paused for a manual gate. Approve to resume the next
        iteration; Deny to send feedback and continue.
      </p>

      {props.csrfMissing ? (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
          Your session expired — reload the page to act on this loop.
        </p>
      ) : null}

      {!denyMode ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Button
            type="button"
            size="lg"
            data-testid="loop-approve-button"
            disabled={submitting || props.csrfMissing}
            onClick={props.onApprove}
            className="h-14 bg-emerald-600 text-base font-semibold text-white hover:bg-emerald-700"
          >
            {props.status === "submitting-approve" ? "Approving…" : "Approve ▸"}
          </Button>
          <Button
            type="button"
            size="lg"
            variant="outline"
            data-testid="loop-deny-button"
            disabled={submitting || props.csrfMissing}
            onClick={props.onOpenDeny}
            className="h-14 border-red-500/40 text-base font-semibold text-red-300 hover:bg-red-500/10"
          >
            Deny ◂
          </Button>
        </div>
      ) : (
        <form
          className="space-y-3"
          data-testid="loop-deny-form"
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmitReject?.();
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[hsl(var(--muted-foreground))]">
              Reason (optional — forwarded to the daemon, NOT logged in
              the audit trail)
            </span>
            <textarea
              value={props.reason}
              onChange={(e) => props.onReasonChange?.(e.target.value)}
              maxLength={1000}
              rows={3}
              data-testid="loop-deny-reason"
              placeholder="What should the next iteration know?"
              className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-2 font-mono text-sm"
            />
          </label>
          {reasonTooLong ? (
            <p className="text-xs text-red-300">
              Reason must be ≤ 1000 characters.
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={props.onCancelDeny}
            >
              Back
            </Button>
            <Button
              type="submit"
              size="lg"
              data-testid="loop-deny-submit"
              disabled={submitting || reasonTooLong || props.csrfMissing}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {props.status === "submitting-reject" ? "Denying…" : "Confirm deny"}
            </Button>
          </div>
        </form>
      )}

      {props.status === "error" ? (
        <p
          data-testid="loop-approval-error"
          className="mt-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300"
        >
          <span className="font-mono font-semibold">{props.errorCode}</span>
          {" — "}
          {props.errorMessage ?? "request failed"}
        </p>
      ) : null}
    </section>
  );
}

export interface LoopApprovalGateProps {
  loopId: string;
  /** Fired after a successful approve OR reject so the page can refresh. */
  onResolved?: () => void;
}

export function LoopApprovalGate({ loopId, onResolved }: LoopApprovalGateProps) {
  const [status, setStatus] = useState<LoopApprovalGateStatus>("idle");
  const [reason, setReason] = useState("");
  const [alreadyFinalized, setAlreadyFinalized] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [csrfMissing, setCsrfMissing] = useState(false);

  const readCsrf = useCallback((): string | null => {
    const token = readCsrfTokenFromCookie(document.cookie);
    if (token === null) {
      setCsrfMissing(true);
      return null;
    }
    setCsrfMissing(false);
    return token;
  }, []);

  const approve = useCallback(async () => {
    const csrf = readCsrf();
    if (csrf === null) return;
    setStatus("submitting-approve");
    setErrorCode(null);
    setErrorMessage(null);
    try {
      const { url, init } = buildLoopApproveRequest({ loopId }, csrf);
      const res = await fetch(url, init);
      const json: unknown = await res.json();
      const result = parseTrpcResponse<LoopGateResult>(json);
      setAlreadyFinalized(result.alreadyFinalized);
      setStatus("resolved");
      onResolved?.();
    } catch (err) {
      const e =
        err instanceof LoopMutationError
          ? err
          : err instanceof DispatchError
          ? err
          : new LoopMutationError("INTERNAL_SERVER_ERROR", String(err));
      setErrorCode(e.code);
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, [loopId, onResolved, readCsrf]);

  const submitReject = useCallback(async () => {
    const csrf = readCsrf();
    if (csrf === null) return;
    setStatus("submitting-reject");
    setErrorCode(null);
    setErrorMessage(null);
    try {
      const trimmed = reason.trim();
      const input = trimmed.length > 0 ? { loopId, reason: trimmed } : { loopId };
      const { url, init } = buildLoopRejectRequest(input, csrf);
      const res = await fetch(url, init);
      const json: unknown = await res.json();
      const result = parseTrpcResponse<LoopGateResult>(json);
      setAlreadyFinalized(result.alreadyFinalized);
      setStatus("resolved");
      onResolved?.();
    } catch (err) {
      const e =
        err instanceof LoopMutationError
          ? err
          : err instanceof DispatchError
          ? err
          : new LoopMutationError("INTERNAL_SERVER_ERROR", String(err));
      setErrorCode(e.code);
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, [loopId, reason, onResolved, readCsrf]);

  const openDeny = useCallback(() => {
    if (readCsrf() === null) return;
    setStatus("denying");
    setErrorCode(null);
    setErrorMessage(null);
  }, [readCsrf]);

  const cancelDeny = useCallback(() => {
    setStatus("idle");
    setErrorCode(null);
    setErrorMessage(null);
  }, []);

  return (
    <LoopApprovalGateView
      status={status}
      reason={reason}
      alreadyFinalized={alreadyFinalized}
      errorCode={errorCode}
      errorMessage={errorMessage}
      csrfMissing={csrfMissing}
      onApprove={() => void approve()}
      onOpenDeny={openDeny}
      onCancelDeny={cancelDeny}
      onSubmitReject={() => void submitReject()}
      onReasonChange={setReason}
    />
  );
}
