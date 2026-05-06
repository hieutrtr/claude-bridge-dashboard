"use client";

// P2-T11 — confirmation pattern for destructive mutations (kill, cancel).
// The user must type a short token (the agent name for kill, the loop
// id for a future cancel) before the action button enables. The dialog
// is intentionally *UX*, not security: the underlying tRPC procedure is
// already gated by CSRF (T08), rate-limit (T07), and audited (T04). The
// dialog stops a slip-of-the-thumb on a phone, not a determined caller.
//
// Two named exports, mirroring `<DispatchDialog>` (T02):
//   * `DangerConfirmView`  — pure props-driven markup. No hooks, no
//     `document` access. Tested via `renderToStaticMarkup` across the
//     full state matrix.
//   * `DangerConfirm`      — wrapper that owns local state, reads
//     `document.cookie` once on open, and awaits the parent's
//     `onSubmit` to drive `success` / `error` transitions. The wrapper
//     does not know about `tasks.kill` directly; consumers like
//     `<KillTaskButton>` plug the mutation in via `onSubmit`.

import { useCallback, useState } from "react";

import { Button } from "@/src/components/ui/button";
import {
  isConfirmationMatch,
  readCsrfTokenFromCookie,
} from "@/src/lib/danger-confirm-client";
import { DispatchError } from "@/src/lib/dispatch-client";

export type DangerConfirmStatus =
  | "idle"
  | "submitting"
  | "success"
  | "error";

export interface DangerConfirmViewProps {
  open: boolean;
  status: DangerConfirmStatus;
  /** Verb shown in the heading + action button (e.g. "Kill"). */
  verb: string;
  /** Human-readable subject (e.g. "task #42 on agent alpha"). */
  subject: string;
  /** Token the user must type to enable the action button. */
  expectedConfirmation: string;
  /** Current value of the typed confirmation input. */
  typed: string;
  /** When `success`, mention "already terminated" if true. */
  alreadyTerminated: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  csrfMissing: boolean;
  onTypeChange?: (value: string) => void;
  onConfirm?: () => void;
  onClose?: () => void;
}

export function DangerConfirmView(props: DangerConfirmViewProps) {
  if (!props.open) return null;

  const matched = isConfirmationMatch(props.typed, props.expectedConfirmation);
  const actionDisabled =
    props.status === "submitting" ||
    props.csrfMissing ||
    !matched;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="danger-confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-lg border border-red-500/40 bg-[hsl(var(--background))] shadow-xl">
        <header className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-4 py-3">
          <h2
            id="danger-confirm-title"
            className="text-base font-semibold tracking-tight text-red-300"
          >
            {props.verb} {props.subject}
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label={`Close ${props.verb.toLowerCase()} dialog`}
            className="rounded-md px-2 py-1 text-sm text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
          >
            ✕
          </button>
        </header>

        {props.status === "success" ? (
          <div className="space-y-4 px-4 py-6">
            <p className="text-sm">
              {props.verb}ed.
              {props.alreadyTerminated
                ? " The task was already terminated; the daemon reported nothing to kill."
                : null}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" type="button" onClick={props.onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4 px-4 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              props.onConfirm?.();
            }}
          >
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              This action cannot be undone. Type{" "}
              <code className="rounded bg-[hsl(var(--muted))] px-1 font-mono text-[hsl(var(--foreground))]">
                {props.expectedConfirmation}
              </code>{" "}
              to confirm.
            </p>

            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[hsl(var(--muted-foreground))]">
                Confirmation
              </span>
              <input
                type="text"
                data-role="confirm-input"
                value={props.typed}
                onChange={(e) => props.onTypeChange?.(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 font-mono text-sm"
              />
            </label>

            {props.csrfMissing ? (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                Your session expired — reload the page to continue.
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
              <Button
                type="submit"
                data-role="confirm-action"
                disabled={actionDisabled}
                className="bg-red-600 text-white hover:bg-red-700"
              >
                {props.status === "submitting" ? `${props.verb}ing…` : props.verb}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export interface DangerConfirmProps {
  /** Trigger element rendered when the dialog is closed. */
  trigger: React.ReactNode;
  verb: string;
  subject: string;
  expectedConfirmation: string;
  /**
   * Performs the destructive mutation. Resolved value is interpreted
   * by the dialog: `{ alreadyTerminated?: boolean }` adjusts the
   * success copy. Rejection puts the dialog in `error` state. The
   * dialog itself never knows the wire format.
   */
  onSubmit: () => Promise<{ alreadyTerminated?: boolean } | void>;
  /** Called after the user clicks Close on the success state. */
  onSuccess?: () => void;
}

export function DangerConfirm(props: DangerConfirmProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<DangerConfirmStatus>("idle");
  const [typed, setTyped] = useState("");
  const [alreadyTerminated, setAlreadyTerminated] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [csrfMissing, setCsrfMissing] = useState(false);

  const openDialog = useCallback(() => {
    setOpen(true);
    setStatus("idle");
    setTyped("");
    setAlreadyTerminated(false);
    setErrorCode(null);
    setErrorMessage(null);
    setCsrfMissing(readCsrfTokenFromCookie(document.cookie) === null);
  }, []);

  const closeDialog = useCallback(() => {
    if (status === "success") {
      props.onSuccess?.();
    }
    setOpen(false);
  }, [status, props]);

  const confirm = useCallback(async () => {
    setStatus("submitting");
    setErrorCode(null);
    setErrorMessage(null);
    try {
      const result = await props.onSubmit();
      if (result && typeof result === "object" && "alreadyTerminated" in result) {
        setAlreadyTerminated(Boolean(result.alreadyTerminated));
      }
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
  }, [props]);

  return (
    <>
      <span onClick={openDialog} role="presentation">
        {props.trigger}
      </span>
      <DangerConfirmView
        open={open}
        status={status}
        verb={props.verb}
        subject={props.subject}
        expectedConfirmation={props.expectedConfirmation}
        typed={typed}
        alreadyTerminated={alreadyTerminated}
        errorCode={errorCode}
        errorMessage={errorMessage}
        csrfMissing={csrfMissing}
        onTypeChange={setTyped}
        onConfirm={() => void confirm()}
        onClose={closeDialog}
      />
    </>
  );
}
