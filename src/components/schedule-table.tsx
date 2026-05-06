// P3-T5 — `/schedules` page table. Pure presentational; the page server
// component fetches `schedules.list` via tRPC `createCaller` and hands
// rows down. Same shape as `<LoopTable>` — no virtualization, capped at
// the daemon's typical row count (well under the 1k threshold per v1
// ARCH §11).
//
// Columns match the v1 P3-T5 acceptance: name, agent, prompt
// (truncated), cadence (cron expression rendered human-readable via
// `cronstrue` or interval fallback), next_run, last_run, paused state,
// run count. Pause/resume/delete inline buttons land in T7; T5 ships
// the read-only baseline.

import Link from "next/link";

import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent } from "@/src/components/ui/card";
import { ScheduleRowActions } from "@/src/components/schedule-row-actions";
import { formatCadence, formatNextRun } from "@/src/lib/cron-format";
import type { ScheduleListRow } from "@/src/server/dto";

const PROMPT_PREVIEW_LENGTH = 80;

function truncatePrompt(text: string): string {
  if (text.length <= PROMPT_PREVIEW_LENGTH) return text;
  return `${text.slice(0, PROMPT_PREVIEW_LENGTH - 1)}…`;
}

function formatTimestamp(value: string | null): string {
  if (value === null || value.length === 0) return "—";
  return value;
}

interface StatusBadge {
  label: string;
  variant: "running" | "idle" | "error" | "unknown";
}

function statusBadge(row: ScheduleListRow): StatusBadge {
  if (!row.enabled) {
    return { label: "Paused", variant: "idle" };
  }
  if (row.consecutiveErrors > 0 && row.lastError !== null) {
    return { label: "Failing", variant: "error" };
  }
  return { label: "Active", variant: "running" };
}

export interface ScheduleTableProps {
  items: ScheduleListRow[];
  isFiltered: boolean;
}

export function ScheduleTable({ items, isFiltered }: ScheduleTableProps) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {isFiltered ? (
              <>
                No schedules match the current filters. Adjust them above
                or{" "}
                <Link
                  href="/schedules"
                  className="underline hover:text-[hsl(var(--foreground))]"
                >
                  clear all
                </Link>
                .
              </>
            ) : (
              <>
                No recurring schedules yet. Use{" "}
                <code className="font-mono">bridge_schedule_add</code> from
                the MCP host or{" "}
                <code className="font-mono">bridge schedule add</code> on
                the CLI to create one. The "New schedule" dialog lands in
                P3-T6.
              </>
            )}
          </p>
        </CardContent>
      </Card>
    );
  }

  // `now` is captured once at render so all rows in the same fetch
  // resolve their cron-fallback `next_run` against the same instant —
  // avoids the visual jitter you'd get from calling `new Date()` per
  // row when they're a microsecond apart.
  const now = new Date();

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
        <table className="w-full text-sm">
          <thead className="bg-[hsl(var(--muted))] text-left text-xs text-[hsl(var(--muted-foreground))]">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Agent</th>
              <th className="px-3 py-2 font-medium">Prompt</th>
              <th className="px-3 py-2 font-medium">Cadence</th>
              <th className="px-3 py-2 font-medium">Next run</th>
              <th className="px-3 py-2 font-medium">Last run</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Runs</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const cadence = formatCadence({
                cronExpr: row.cronExpr,
                intervalMinutes: row.intervalMinutes,
              });
              const nextRun = formatNextRun({
                cronExpr: row.cronExpr,
                intervalMinutes: row.intervalMinutes,
                nextRunAt: row.nextRunAt,
                lastRunAt: row.lastRunAt,
                now,
              });
              const status = statusBadge(row);
              return (
                <tr
                  key={row.id}
                  className="border-t border-[hsl(var(--border))]"
                  data-testid="schedule-row"
                >
                  <td className="px-3 py-2 font-medium">{row.name}</td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/agents/${encodeURIComponent(row.agentName)}`}
                      className="hover:underline"
                    >
                      {row.agentName}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]" title={row.prompt}>
                    {truncatePrompt(row.prompt)}
                  </td>
                  <td className="px-3 py-2">
                    <span title={row.cronExpr ?? undefined} className="text-xs">
                      {cadence}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatTimestamp(nextRun)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatTimestamp(row.lastRunAt)}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {row.runCount}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ScheduleRowActions
                      scheduleId={row.id}
                      scheduleName={row.name}
                      enabled={row.enabled}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
