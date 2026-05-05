// T03/T04 — Card grid for /agents. T03 introduced the grid; T04 wraps
// each card in a `<Link>` to `/agents/[name]` (the route added by T04).
// Pure presentational; the page server component fetches `agents.list`
// via tRPC createCaller and hands it down.

import Link from "next/link";

import type { Agent } from "@/src/server/dto";
import { agentStatusBadge } from "@/src/lib/agent-status";
import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Badge } from "@/src/components/ui/badge";

export function AgentsGrid({ agents }: { agents: Agent[] }) {
  if (agents.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No agents yet</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            Use <code className="font-mono">bridge_create_agent</code> from the
            MCP host or <code className="font-mono">bridge agent create</code>{" "}
            on the CLI to register one.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {agents.map((a) => {
        const badge = agentStatusBadge(a.state);
        return (
          <Link
            key={`${a.name}::${a.projectDir}`}
            href={`/agents/${encodeURIComponent(a.name)}`}
            className="rounded-lg outline-none transition-colors hover:ring-2 hover:ring-[hsl(var(--border))] focus-visible:ring-2 focus-visible:ring-[hsl(var(--foreground))]"
          >
            <Card className="h-full">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="break-all">{a.name}</CardTitle>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                <div
                  className="truncate font-mono text-xs text-[hsl(var(--muted-foreground))]"
                  title={a.projectDir}
                >
                  {a.projectDir}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[hsl(var(--muted-foreground))]">Model</span>
                  <span className="font-mono">{a.model ?? "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[hsl(var(--muted-foreground))]">Last task</span>
                  <span className="font-mono text-xs">{a.lastTaskAt ?? "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[hsl(var(--muted-foreground))]">Total tasks</span>
                  <span className="font-mono">{a.totalTasks ?? 0}</span>
                </div>
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
