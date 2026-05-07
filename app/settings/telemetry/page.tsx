// P4-T11 — `/settings/telemetry` page (owner-only).
//
// Server component. Resolves the caller via the session cookie + the
// `auth.me` tRPC query, then either renders the toggle + recent-rows
// panel (`<TelemetryForm>`), a "members can't manage telemetry" notice
// for non-owner authenticated users, or a "not signed in" CTA.
//
// Default state is OFF — the migration leaves `dashboard_meta` empty
// and `getTelemetryOptIn()` returns false until the owner explicitly
// flips the toggle. The toggle is install-scoped (one row in
// `dashboard_meta`); members cannot enable/disable telemetry on behalf
// of the install owner.

import { cookies } from "next/headers";

import { appRouter } from "@/src/server/routers/_app";
import { SESSION_COOKIE, readAuthEnv, verifySession } from "@/src/lib/auth";
import { TelemetryForm } from "@/src/components/telemetry-form";

export const dynamic = "force-dynamic";

async function readSessionSubject(): Promise<string | null> {
  const { secret } = readAuthEnv();
  if (!secret) return null;
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const payload = await verifySession(token, secret);
    return payload?.sub ?? null;
  } catch {
    return null;
  }
}

export default async function TelemetrySettingsPage() {
  const userId = await readSessionSubject();
  const caller = appRouter.createCaller({ userId });

  const me = await caller.auth.me();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Telemetry</h1>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          Default <strong>OFF</strong>. When enabled, Bridge records
          page views and action latencies <strong>locally</strong> in
          your <code>bridge.db</code>. Nothing leaves your machine
          unless you configure an upload endpoint.
        </p>
      </header>

      {me === null ? <NotSignedIn /> : me.role !== "owner" ? (
        <NotOwner />
      ) : (
        <OwnerView />
      )}
    </div>
  );
}

async function OwnerView() {
  const caller = appRouter.createCaller({ userId: "owner" });
  // We can't always rely on the env-owner sub working here (it does —
  // see `auth.me`'s fallback) but the form's queries below run via
  // tRPC client fetches in the browser, so the SSR call is just to
  // hydrate the initial state and the "what we collect" panel.
  let initialEnabled = false;
  let installId: string | null = null;
  let recent: Array<{
    id: number;
    eventType: string;
    eventName: string;
    valueMs: number | null;
    createdAt: number;
  }> = [];
  let counts = { total: 0, pageView: 0, actionLatency: 0, featureUsed: 0 };
  try {
    const status = await caller.telemetry.optInStatus();
    initialEnabled = status.enabled;
    installId = status.installId;
    counts = status.counts;
    if (status.enabled) {
      const rows = await caller.telemetry.recent({ limit: 25 });
      recent = [...rows.events];
    }
  } catch {
    // DB unreachable during SSR — fall through to the off-state UI.
  }

  return (
    <TelemetryForm
      initialEnabled={initialEnabled}
      installId={installId}
      counts={counts}
      recent={recent}
    />
  );
}

function NotOwner() {
  return (
    <div
      className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 text-sm"
      data-role="not-owner-banner"
    >
      <p className="text-[hsl(var(--muted-foreground))]">
        Telemetry is install-wide and managed by the owner. Ask the owner
        if you would like the install-scoped toggle flipped.
      </p>
    </div>
  );
}

function NotSignedIn() {
  return (
    <div
      className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 text-sm"
      data-role="signed-out-banner"
    >
      <p className="text-[hsl(var(--muted-foreground))]">
        Sign in via <a className="underline" href="/login">/login</a> to
        manage telemetry settings.
      </p>
    </div>
  );
}
