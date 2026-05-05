// T05 — global Tasks page table. Pure presentational; the page server
// component fetches `tasks.list` via tRPC createCaller and hands rows
// down. Distinct from `<TaskTable>` (T04, agent-detail) because this
// surface adds an Agent column with a `<Link>` back to /agents/[name],
// and the row Id links to /tasks/[id] (T06 lands the detail page).
//
// No virtualization — paginated 50/page. See T05 task spec / Notes.

import Link from "next/link";

import type { GlobalTaskRow } from "@/src/server/dto";
import { taskStatusBadge } from "@/src/lib/task-status";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent } from "@/src/components/ui/card";

const PROMPT_TRUNCATE = 80;

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

export interface GlobalTaskTableProps {
  items: GlobalTaskRow[];
  nextCursor: number | null;
  // Forwarded onto the "Next →" link so cursor advances while keeping
  // the existing filter params intact.
  buildNextHref: (cursor: number) => string;
  // True if any filter is set; controls the empty-state copy so users
  // know whether the table is empty because of the daemon DB or the
  // filter strip.
  isFiltered: boolean;
}

export function GlobalTaskTable({
  items,
  nextCursor,
  buildNextHref,
  isFiltered,
}: GlobalTaskTableProps) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {isFiltered ? (
              <>
                No tasks match the current filters. Adjust them above or{" "}
                <Link
                  href="/tasks"
                  className="underline hover:text-[hsl(var(--foreground))]"
                >
                  clear all
                </Link>
                .
              </>
            ) : (
              <>
                No tasks dispatched yet. Use{" "}
                <code className="font-mono">bridge_dispatch</code> from the MCP
                host or <code className="font-mono">bridge dispatch</code> on
                the CLI to start one.
              </>
            )}
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
              <th className="px-3 py-2 font-medium">Agent</th>
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
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      href={`/tasks/${task.id}`}
                      className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                    >
                      {task.id}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {task.agentName ? (
                      <Link
                        href={`/agents/${encodeURIComponent(task.agentName)}`}
                        className="hover:underline"
                      >
                        {task.agentName}
                      </Link>
                    ) : (
                      <span className="text-[hsl(var(--muted-foreground))]">—</span>
                    )}
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
            href={buildNextHref(nextCursor)}
            className="rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--card))]"
          >
            Next →
          </Link>
        </div>
      )}
    </div>
  );
}
