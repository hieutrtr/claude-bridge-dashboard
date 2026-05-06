"use client";

// P4-T06 — `/settings/notifications` page form.
//
// Toggle matrix (in-app, email digest, browser push) + hour/tz picker.
// Optimistic UI on individual toggles (per Phase 4 invariant T06 §5):
// flip locally on click, fire mutation, revert on error. Reset wraps
// `<DangerConfirm>` so a slip-of-the-thumb on mobile cannot blow away
// configured prefs.
//
// Privacy: every mutation request has CSRF + rate-limit + audit on
// the server. The component does NOT log values to the console; the
// audit log records changed KEY NAMES only. If you want a value diff
// for forensics, the audit row is the wrong shape — it's by design.

import { useCallback, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/src/components/ui/button";
import { DangerConfirm } from "@/src/components/danger-confirm";
import { readCsrfTokenFromCookie } from "@/src/lib/danger-confirm-client";
import {
  HOURS,
  NotificationsMutationError,
  buildResetRequest,
  buildUpdateRequest,
  diffPrefs,
  formatHour,
  isValidTimezone,
  parseTrpcResponse,
  type NotificationsMutationResult,
  type NotificationsPrefsResponse,
  type NotificationsUpdateInput,
} from "@/src/lib/notifications-client";

export interface NotificationsFormProps {
  initial: NotificationsPrefsResponse;
}

interface FormState {
  prefs: NotificationsPrefsResponse;
  status: "idle" | "saving" | "success" | "error";
  errorCode: string | null;
  errorMessage: string | null;
  banner: string | null;
}

function emptyState(initial: NotificationsPrefsResponse): FormState {
  return {
    prefs: initial,
    status: "idle",
    errorCode: null,
    errorMessage: null,
    banner: null,
  };
}

export function NotificationsForm(props: NotificationsFormProps) {
  const router = useRouter();
  const [state, setState] = useState<FormState>(() => emptyState(props.initial));
  const [tzDraft, setTzDraft] = useState(props.initial.emailDigestTz);

  const submitUpdate = useCallback(
    async (
      input: NotificationsUpdateInput,
      optimistic?: NotificationsPrefsResponse,
    ) => {
      const before = state.prefs;
      const previewed = optimistic ?? before;
      setState((s) => ({
        ...s,
        prefs: previewed,
        status: "saving",
        errorCode: null,
        errorMessage: null,
        banner: null,
      }));
      const csrf = readCsrfTokenFromCookie(document.cookie);
      if (csrf === null) {
        setState({
          prefs: before,
          status: "error",
          errorCode: "csrf_missing",
          errorMessage: "Your session expired — reload the page.",
          banner: null,
        });
        return;
      }
      const { url, init } = buildUpdateRequest(input, csrf);
      try {
        const res = await fetch(url, init);
        const data = (await res.json()) as unknown;
        const out = parseTrpcResponse<NotificationsMutationResult>(data);
        const changed = diffPrefs(before, out.prefs);
        const banner =
          changed.length === 0
            ? "No changes."
            : `Saved (${changed.length} change${changed.length === 1 ? "" : "s"}).`;
        setState({
          prefs: out.prefs,
          status: "success",
          errorCode: null,
          errorMessage: null,
          banner,
        });
        router.refresh();
      } catch (err) {
        const e =
          err instanceof NotificationsMutationError
            ? err
            : new NotificationsMutationError(
                "INTERNAL_SERVER_ERROR",
                String(err),
              );
        setState({
          prefs: before,
          status: "error",
          errorCode: e.code,
          errorMessage: e.message,
          banner: null,
        });
      }
    },
    [state.prefs, router],
  );

  const onToggleInApp = useCallback(() => {
    const next = !state.prefs.inAppEnabled;
    submitUpdate(
      { inAppEnabled: next },
      { ...state.prefs, inAppEnabled: next },
    );
  }, [state.prefs, submitUpdate]);

  const onToggleEmailDigest = useCallback(() => {
    const next = !state.prefs.emailDigestEnabled;
    submitUpdate(
      { emailDigestEnabled: next },
      { ...state.prefs, emailDigestEnabled: next },
    );
  }, [state.prefs, submitUpdate]);

  const onToggleBrowserPush = useCallback(async () => {
    const next = !state.prefs.browserPushEnabled;
    if (next && typeof window !== "undefined" && "Notification" in window) {
      try {
        await Notification.requestPermission();
      } catch {
        // Permission failures are user-visible via the toggle status
        // and do not block recording the toggle bool.
      }
    }
    submitUpdate(
      { browserPushEnabled: next },
      { ...state.prefs, browserPushEnabled: next },
    );
  }, [state.prefs, submitUpdate]);

  const onChangeHour = useCallback(
    (e: FormEvent<HTMLSelectElement>) => {
      const value = Number((e.target as HTMLSelectElement).value);
      if (!Number.isInteger(value) || value < 0 || value > 23) return;
      submitUpdate(
        { emailDigestHour: value },
        { ...state.prefs, emailDigestHour: value },
      );
    },
    [state.prefs, submitUpdate],
  );

  const onSubmitTz = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const next = tzDraft.trim();
      if (!isValidTimezone(next)) {
        setState((s) => ({
          ...s,
          status: "error",
          errorCode: "BAD_REQUEST",
          errorMessage: "Enter a valid IANA timezone (e.g. UTC, Asia/Saigon).",
          banner: null,
        }));
        return;
      }
      if (next === state.prefs.emailDigestTz) return;
      submitUpdate(
        { emailDigestTz: next },
        { ...state.prefs, emailDigestTz: next },
      );
    },
    [tzDraft, state.prefs, submitUpdate],
  );

  const onResetSubmit = useCallback(async () => {
    const before = state.prefs;
    setState((s) => ({ ...s, status: "saving", errorCode: null, errorMessage: null, banner: null }));
    const csrf = readCsrfTokenFromCookie(document.cookie);
    if (csrf === null) {
      setState({
        prefs: before,
        status: "error",
        errorCode: "csrf_missing",
        errorMessage: "Your session expired — reload the page.",
        banner: null,
      });
      throw new NotificationsMutationError(
        "csrf_missing",
        "Your session expired — reload the page.",
      );
    }
    const { url, init } = buildResetRequest(csrf);
    const res = await fetch(url, init);
    const data = (await res.json()) as unknown;
    const out = parseTrpcResponse<NotificationsMutationResult>(data);
    setState({
      prefs: out.prefs,
      status: "success",
      errorCode: null,
      errorMessage: null,
      banner: "Defaults restored.",
    });
    setTzDraft(out.prefs.emailDigestTz);
    router.refresh();
  }, [state.prefs, router]);

  const isSaving = state.status === "saving";

  return (
    <div className="space-y-6">
      {state.banner && (
        <div
          className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-300"
          data-role="prefs-success"
        >
          {state.banner}
        </div>
      )}
      {state.status === "error" && state.errorMessage && (
        <div
          className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-300"
          data-role="prefs-error"
        >
          <p className="font-mono text-xs uppercase">{state.errorCode}</p>
          <p className="mt-1">{state.errorMessage}</p>
        </div>
      )}

      <section className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">In-app notifications</h2>
            <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
              Show toasts when your dispatched tasks finish or fail.
            </p>
          </div>
          <ToggleSwitch
            label="In-app notifications"
            data-role="toggle-in-app"
            checked={state.prefs.inAppEnabled}
            disabled={isSaving}
            onClick={onToggleInApp}
          />
        </header>
      </section>

      <section className="space-y-4 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Email digest</h2>
            <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
              Daily summary of completed tasks + cost in the last 24h.
              Default off — opt-in.
            </p>
          </div>
          <ToggleSwitch
            label="Email digest"
            data-role="toggle-email-digest"
            checked={state.prefs.emailDigestEnabled}
            disabled={isSaving}
            onClick={onToggleEmailDigest}
          />
        </header>

        {state.prefs.emailDigestEnabled && (
          <div className="grid gap-4 sm:grid-cols-2" data-role="digest-options">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Send hour (local TZ)</span>
              <select
                aria-label="Email digest hour"
                data-role="digest-hour"
                value={state.prefs.emailDigestHour}
                disabled={isSaving}
                onChange={(e) => onChangeHour(e as unknown as FormEvent<HTMLSelectElement>)}
                className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2"
              >
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {formatHour(h)}
                  </option>
                ))}
              </select>
            </label>

            <form className="flex flex-col gap-1 text-sm" onSubmit={onSubmitTz}>
              <label htmlFor="digest-tz" className="font-medium">
                Timezone (IANA)
              </label>
              <div className="flex gap-2">
                <input
                  id="digest-tz"
                  data-role="digest-tz"
                  value={tzDraft}
                  onChange={(e) => setTzDraft(e.currentTarget.value)}
                  placeholder="UTC"
                  className="flex-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 font-mono text-sm"
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={isSaving || tzDraft.trim() === state.prefs.emailDigestTz}
                >
                  Save
                </Button>
              </div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                Examples: <code>UTC</code>, <code>Asia/Saigon</code>,{" "}
                <code>America/Los_Angeles</code>.
              </p>
            </form>
          </div>
        )}
      </section>

      <section className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Browser push</h2>
            <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
              Stub: records the toggle but push delivery ships in v0.2.0.
              Toggling on requests browser permission.
            </p>
          </div>
          <ToggleSwitch
            label="Browser push"
            data-role="toggle-browser-push"
            checked={state.prefs.browserPushEnabled}
            disabled={isSaving}
            onClick={onToggleBrowserPush}
          />
        </header>
      </section>

      <div className="flex justify-end pt-2">
        <DangerConfirm
          verb="Reset"
          subject="notification preferences"
          expectedConfirmation="reset"
          onSubmit={onResetSubmit}
          trigger={
            <Button variant="ghost" size="sm" data-role="reset-prefs">
              Reset to defaults
            </Button>
          }
        />
      </div>
    </div>
  );
}

interface ToggleProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
  "data-role"?: string;
}

function ToggleSwitch(props: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      data-role={props["data-role"]}
      disabled={props.disabled}
      onClick={props.onClick}
      className={
        "inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-[hsl(var(--border))] transition-colors focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))] disabled:cursor-not-allowed disabled:opacity-60 " +
        (props.checked ? "bg-emerald-600" : "bg-[hsl(var(--muted))]")
      }
    >
      <span
        className={
          "inline-block h-5 w-5 transform rounded-full bg-white transition-transform " +
          (props.checked ? "translate-x-5" : "translate-x-0.5")
        }
      />
    </button>
  );
}
