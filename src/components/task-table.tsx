// T04 — agent-detail Tasks tab table. Pure presentational; the page
// server component fetches `tasks.listByAgent` and hands rows down.
// The full global Tasks table (T05) will introduce sorting / filtering
// and a virtualized row list — this one is intentionally simple (≤ 50
// rows per page).

import Link from "next/link";

import type { AgentTaskRow } from "@/src/server/dto";
import { taskStatusBadge } from "@/src/lib/task-status";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent } from "@/src/components/ui/card";

const PROMPT_TRUNCATE = 80;

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

export interface TaskTableProps {
  items: AgentTaskRow[];
  nextCursor: number | null;
  agentName: string;
}

export function TaskTable({ items, nextCursor, agentName }: TaskTableProps) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            No tasks for this agent yet. Dispatch one via{" "}
            <code className="font-mono">bridge_dispatch</code> from the MCP
            host or <code className="font-mono">bridge dispatch</code> on the
            CLI.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
        <table className="w-full text-sm">
          <thead className="bg-[hsl(var(--muted))] text-left text-xs text-[hsl(var(--muted-foreground))]">
            <tr>
              <th className="px-3 py-2 font-medium">Id</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Prompt</th>
              <th className="px-3 py-2 font-medium">Channel</th>
              <th className="px-3 py-2 font-medium text-right">Cost</th>
              <th className="px-3 py-2 font-medium text-right">Duration</th>
              <th className="px-3 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {items.map((task) => {
              const badge = taskStatusBadge(task.status);
              return (
                <tr
                  key={task.id}
                  className="border-t border-[hsl(var(--border))]"
                >
                  <td className="px-3 py-2 font-mono text-xs text-[hsl(var(--muted-foreground))]">
                    {task.id}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </td>
                  <td
                    className="max-w-[28rem] truncate px-3 py-2"
                    title={task.prompt}
                  >
                    {truncate(task.prompt, PROMPT_TRUNCATE)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {task.channel ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {task.costUsd === null ? "—" : `$${task.costUsd.toFixed(4)}`}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {task.durationMs === null ? "—" : `${task.durationMs}ms`}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {task.createdAt ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {nextCursor !== null && (
        <div className="flex justify-end">
          <Link
            href={`/agents/${encodeURIComponent(agentName)}?tab=tasks&cursor=${nextCursor}`}
            className="rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--card))]"
          >
            Next →
          </Link>
        </div>
      )}
    </div>
  );
}
