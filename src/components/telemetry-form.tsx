"use client";

// P4-T11 — `/settings/telemetry` toggle + transparency panel.
//
// Renders:
//   * The big install-scoped toggle (switch role, AA-contrast emerald
//     background when on, muted when off).
//   * A "What we collect" explanation block — list of event types,
//     promise list (no PII / no IP / no UA / no path-with-id).
//   * The recent-events table (last 25 rows) — only shown when
//     telemetry is ON. The owner can confirm what is being recorded.
//
// Mutation flow mirrors the notifications form: read CSRF cookie, POST
// `telemetry.setOptIn`, parse the tRPC envelope, surface success / error
// banners, and `router.refresh()` on success so the SSR-rendered
// recent-events list re-hydrates.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/src/components/ui/button";
import { readCsrfTokenFromCookie } from "@/src/lib/danger-confirm-client";
import {
  TelemetryError,
  buildSetOptInRequest,
  parseTrpcResponse,
  type SetOptInResult,
} from "@/src/lib/telemetry-client";

export interface TelemetryFormProps {
  initialEnabled: boolean;
  installId: string | null;
  counts: {
    total: number;
    pageView: number;
    actionLatency: number;
    featureUsed: number;
  };
  recent: ReadonlyArray<{
    id: number;
    eventType: string;
    eventName: string;
    valueMs: number | null;
    createdAt: number;
  }>;
}

interface FormState {
  enabled: boolean;
  installId: string | null;
  status: "idle" | "saving" | "success" | "error";
  errorCode: string | null;
  errorMessage: string | null;
  banner: string | null;
}

export function TelemetryForm(props: TelemetryFormProps) {
  const router = useRouter();
  const [state, setState] = useState<FormState>({
    enabled: props.initialEnabled,
    installId: props.installId,
    status: "idle",
    errorCode: null,
    errorMessage: null,
    banner: null,
  });

  const onToggle = useCallback(async () => {
    const next = !state.enabled;
    const before = state.enabled;
    setState((s) => ({
      ...s,
      enabled: next,
      status: "saving",
      errorCode: null,
      errorMessage: null,
      banner: null,
    }));
    const csrf = readCsrfTokenFromCookie(document.cookie);
    if (csrf === null) {
      setState({
        enabled: before,
        installId: state.installId,
        status: "error",
        errorCode: "csrf_missing",
        errorMessage: "Your session expired — reload the page.",
        banner: null,
      });
      return;
    }
    const { url, init } = buildSetOptInRequest({ enabled: next }, csrf);
    try {
      const res = await fetch(url, init);
      const data = (await res.json()) as unknown;
      const out = parseTrpcResponse<SetOptInResult>(data);
      setState({
        enabled: out.enabled,
        installId: out.installId,
        status: "success",
        errorCode: null,
        errorMessage: null,
        banner: out.enabled
          ? "Telemetry enabled. Events record locally only."
          : "Telemetry disabled. No new events will be recorded.",
      });
      router.refresh();
    } catch (err) {
      const e =
        err instanceof TelemetryError
          ? err
          : new TelemetryError("INTERNAL_SERVER_ERROR", String(err));
      setState({
        enabled: before,
        installId: state.installId,
        status: "error",
        errorCode: e.code,
        errorMessage: e.message,
        banner: null,
      });
    }
  }, [state.enabled, state.installId, router]);

  const isSaving = state.status === "saving";

  return (
    <div className="space-y-6">
      {state.banner && (
        <div
          className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-300"
          data-role="telemetry-success"
        >
          {state.banner}
        </div>
      )}
      {state.status === "error" && state.errorMessage && (
        <div
          className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-300"
          data-role="telemetry-error"
        >
          <p className="font-mono text-xs uppercase">{state.errorCode}</p>
          <p className="mt-1">{state.errorMessage}</p>
        </div>
      )}

      <section
        className="space-y-4 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5"
        data-role="telemetry-toggle-section"
      >
        <header className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">
              Anonymous usage telemetry
            </h2>
            <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
              Default off. Records page views, feature usage, and action
              latencies into <code>bridge.db</code>. No user, IP, UA, or
              IDs in URLs are stored.
            </p>
          </div>
          <ToggleSwitch
            label="Telemetry"
            data-role="toggle-telemetry"
            checked={state.enabled}
            disabled={isSaving}
            onClick={onToggle}
          />
        </header>

        {state.enabled && state.installId && (
          <div
            className="rounded-md bg-[hsl(var(--muted))]/30 p-3 text-xs text-[hsl(var(--muted-foreground))]"
            data-role="install-id"
          >
            Install ID:{" "}
            <code className="font-mono text-[11px]">{state.installId}</code>
            <span className="ml-2">
              (one stable UUID; no user attribution)
            </span>
          </div>
        )}
      </section>

      <section
        className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5"
        data-role="what-we-collect"
      >
        <h2 className="text-base font-semibold">What we collect</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[hsl(var(--muted-foreground))]">
          <li>
            <strong>page_view</strong> — route name only (e.g.{" "}
            <code>/tasks</code>, <code>/cost</code>). IDs in the URL are
            replaced with <code>[id]</code>.
          </li>
          <li>
            <strong>action_latency</strong> — duration of in-app
            actions (e.g. <code>dispatch.success</code>) clamped to the
            0–600,000 ms range.
          </li>
          <li>
            <strong>feature_used</strong> — keystrokes for ⌘K palette
            commands or theme toggles.
          </li>
        </ul>
        <h3 className="mt-4 text-sm font-semibold">What we do not collect</h3>
        <ul
          className="mt-2 list-disc space-y-1 pl-5 text-sm text-[hsl(var(--muted-foreground))]"
          data-role="never-list"
        >
          <li>No user IDs or email addresses.</li>
          <li>No IP addresses, no User-Agent strings.</li>
          <li>No prompt content, agent names, or task IDs.</li>
          <li>No upload — events stay in your local SQLite file.</li>
        </ul>
      </section>

      {state.enabled && (
        <section
          className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5"
          data-role="recent-events"
        >
          <header className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">
              Recent events ({props.counts.total} total)
            </h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.refresh()}
              disabled={isSaving}
            >
              Refresh
            </Button>
          </header>
          {props.recent.length === 0 ? (
            <p
              className="mt-3 text-sm text-[hsl(var(--muted-foreground))]"
              data-role="no-events"
            >
              No events recorded yet. Browse around the dashboard and the
              recorder will start logging anonymous events.
            </p>
          ) : (
            <table className="mt-3 w-full text-left text-sm">
              <thead className="border-b border-[hsl(var(--border))] text-xs uppercase text-[hsl(var(--muted-foreground))]">
                <tr>
                  <th className="py-2 pr-3">When</th>
                  <th className="pr-3">Type</th>
                  <th className="pr-3">Name</th>
                  <th className="pr-3 text-right">Value (ms)</th>
                </tr>
              </thead>
              <tbody>
                {props.recent.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b border-[hsl(var(--border))]/40"
                  >
                    <td className="py-2 pr-3 text-xs text-[hsl(var(--muted-foreground))]">
                      {new Date(e.createdAt).toISOString()}
                    </td>
                    <td className="pr-3 font-mono text-xs">{e.eventType}</td>
                    <td className="pr-3 font-mono text-xs">{e.eventName}</td>
                    <td className="pr-3 text-right font-mono text-xs">
                      {e.valueMs ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
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
