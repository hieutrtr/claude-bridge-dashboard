// T11 — "Daemon offline" banner. Rendered by `app/error.tsx` when the
// server component below it throws a `BridgeNotInstalledError`. Pure
// server component (no "use client", no state, no fetch) — the retry
// control lives in the boundary itself.
//
// Acceptance: heading + the configured `$CLAUDE_BRIDGE_HOME` (or
// explicit config path) + the `bridge install` remediation copy.

import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/card";

export interface OfflineBannerProps {
  home: string;
  configPath?: string;
}

export function OfflineBanner({ home, configPath }: OfflineBannerProps) {
  const path = configPath ?? `${home}/config.json`;
  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="text-amber-300">Daemon offline</CardTitle>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          The dashboard could not find the claude-bridge daemon. The
          dashboard is read-only — no agents, tasks, or cost data are
          available until the daemon is reachable.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            Expected config path
          </div>
          <code className="block break-all rounded-md bg-[hsl(var(--muted))] px-2 py-1 font-mono text-xs">
            {path}
          </code>
          <div className="text-xs text-[hsl(var(--muted-foreground))]">
            <span>(</span>
            <code className="font-mono">CLAUDE_BRIDGE_HOME</code>
            <span> = </span>
            <code className="font-mono">{home}</code>
            <span>)</span>
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            Remediation
          </div>
          <p>
            Run{" "}
            <code className="rounded bg-[hsl(var(--muted))] px-1 py-0.5 font-mono text-xs">
              bridge install
            </code>{" "}
            on the host machine, then reload this page. If the daemon
            is installed elsewhere, point{" "}
            <code className="font-mono">CLAUDE_BRIDGE_HOME</code> at it
            and restart the dashboard.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
