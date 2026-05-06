// P3-T1 — `/loops` page table. Pure presentational; the page server
// component fetches `loops.list` via tRPC createCaller and hands rows
// down. Same shape as `<GlobalTaskTable>` — no virtualization, paginated
// 50/page (well below the 1k row threshold per v1 ARCH §11).
//
// Columns match the v1 P3-T1 acceptance: agent (link), status badge,
// iter progress (current / max), budget (cost / cap), started_at.
// `loop_id` is shown truncated (first 8 chars of the DB-side TEXT
// PK) and links to the detail page (lands in T2).

import Link from "next/link";

import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent } from "@/src/components/ui/card";
import { loopStatusBadge } from "@/src/lib/loop-status";
import type { LoopListRow } from "@/src/server/dto";

function formatCost(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toFixed(4)}`;
}

function formatBudget(total: number, cap: number | null): string {
  return `${formatCost(total)} / ${cap === null ? "—" : formatCost(cap)}`;
}

function shortLoopId(loopId: string): string {
  return loopId.length <= 8 ? loopId : loopId.slice(0, 8);
}

export interface LoopTableProps {
  items: LoopListRow[];
  nextCursor: string | null;
  buildNextHref: (cursor: string) => string;
  isFiltered: boolean;
}

export function LoopTable({
  items,
  nextCursor,
  buildNextHref,
  isFiltered,
}: LoopTableProps) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {isFiltered ? (
              <>
                No loops match the current filters. Adjust them above or{" "}
                <Link
                  href="/loops"
                  className="underline hover:text-[hsl(var(--foreground))]"
                >
                  clear all
                </Link>
                .
              </>
            ) : (
              <>
                No goal loops have been started yet. Use{" "}
                <code className="font-mono">bridge_loop</code> from the MCP
                host or <code className="font-mono">bridge loop</code> on the
                CLI to start one. The "Start loop" dialog lands in P3-T3.
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
              <th className="px-3 py-2 font-medium">Loop</th>
              <th className="px-3 py-2 font-medium">Agent</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Iter</th>
              <th className="px-3 py-2 font-medium text-right">Budget</th>
              <th className="px-3 py-2 font-medium">Started</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const badge = loopStatusBadge(row.status, row.pendingApproval);
              return (
                <tr
                  key={row.loopId}
                  className="border-t border-[hsl(var(--border))]"
                  data-testid="loop-row"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      href={`/loops/${encodeURIComponent(row.loopId)}`}
                      className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                      title={row.loopId}
                    >
                      {shortLoopId(row.loopId)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/agents/${encodeURIComponent(row.agent)}`}
                      className="hover:underline"
                    >
                      {row.agent}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {row.currentIteration} / {row.maxIterations}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatBudget(row.totalCostUsd, row.maxCostUsd)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.startedAt}
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
