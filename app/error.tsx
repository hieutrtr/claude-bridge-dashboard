"use client";

// T11 — root error boundary. Per the Next.js App Router contract, this
// is a client component that wraps the segment in a React error
// boundary; when a server component below throws, the error is
// serialized over the RSC payload and rendered here. We branch on the
// error name (not instanceof, since the prototype is stripped during
// serialization) so a `BridgeNotInstalledError` from
// `src/lib/discovery.ts` surfaces as a dedicated "Daemon offline"
// banner with the configured config path + the `bridge install`
// remediation copy.
//
// Read-only invariant (Phase 1): the boundary issues zero tRPC calls,
// zero DB queries, zero writes. `reset()` is React's boundary reset —
// not a mutation.

import { isBridgeNotInstalledError } from "@/src/lib/bridge-error";
import { OfflineBanner } from "@/src/components/offline-banner";
import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/card";

interface RootErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

const HOME_PATTERN = /CLAUDE_BRIDGE_HOME=([^\s)]+)/;
const PATH_PATTERN = /at\s(\S+\/config\.json)/;

function extractHome(message: string): string {
  const m = HOME_PATTERN.exec(message);
  if (m && m[1]) return m[1];
  return "~/.claude-bridge";
}

function extractConfigPath(message: string): string | undefined {
  const m = PATH_PATTERN.exec(message);
  return m?.[1];
}

export default function RootError({ error, reset }: RootErrorProps) {
  if (isBridgeNotInstalledError(error)) {
    const home = extractHome(error.message);
    const configPath = extractConfigPath(error.message);
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <OfflineBanner home={home} configPath={configPath} />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--card))]"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <Card className="border-red-500/40 bg-red-500/5">
        <CardHeader>
          <CardTitle className="text-red-300">Something went wrong</CardTitle>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            The dashboard hit an unexpected error rendering this page.
            The data layer is read-only, so you can safely retry — no
            state was mutated.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[hsl(var(--muted))] p-3 font-mono text-xs">
            {error.message || "(no message)"}
          </pre>
          {error.digest && (
            <div className="text-xs text-[hsl(var(--muted-foreground))]">
              Digest: <code className="font-mono">{error.digest}</code>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--card))]"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
