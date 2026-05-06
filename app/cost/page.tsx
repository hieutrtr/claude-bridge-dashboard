// T09 — Cost analytics page. Server component; calls
// `analytics.summary({ window: '30d' })` + `analytics.dailyCost({})` via
// the in-process tRPC `createCaller` (no HTTP roundtrip). KPI numbers
// and the empty state are rendered server-side; only the three Recharts
// charts ship as a client leaf (`<CostCharts>`) for layout measurement.
//
// Read-only: page issues only tRPC `query` procedures. No mutations,
// no dispatch, no DB writes — guard mirrors T05/T06/T07/T08.

import { appRouter } from "@/src/server/routers/_app";
import { getSessionSubject } from "@/src/server/session";
import { CostCharts } from "@/src/components/cost-charts";

export const dynamic = "force-dynamic";

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatSinceDate(iso: string): string {
  // SQLite's datetime('now', '-30 days') returns 'YYYY-MM-DD HH:MM:SS'.
  // The page header shows just the date.
  return iso.split(" ")[0] ?? iso;
}

export default async function CostPage() {
  const userId = await getSessionSubject();
  const caller = appRouter.createCaller({ userId });
  const [summary, daily] = await Promise.all([
    caller.analytics.summary({ window: "30d" }),
    caller.analytics.dailyCost({}),
  ]);

  const isEmpty = summary.totalTasks === 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Cost</h1>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          Spend over the last 30 days (since {formatSinceDate(summary.since)}).
          Read-only; numbers match{" "}
          <code className="rounded bg-[hsl(var(--muted))] px-1 py-0.5 text-xs">
            bridge cost
          </code>{" "}
          ± $0.01.
        </p>
      </header>

      <section
        aria-label="Cost summary"
        className="grid grid-cols-1 gap-4 sm:grid-cols-3"
      >
        <KpiCard label="Total spend" value={fmtUsd(summary.totalCostUsd)} />
        <KpiCard label="Tasks" value={String(summary.totalTasks)} />
        <KpiCard label="Avg / task" value={fmtUsd(summary.avgCostPerTask)} />
      </section>

      {isEmpty ? (
        <div className="rounded-lg border border-dashed border-[hsl(var(--border))] p-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
          No completed tasks yet — run a task with{" "}
          <code className="rounded bg-[hsl(var(--muted))] px-1 py-0.5 text-xs">
            bridge dispatch
          </code>{" "}
          to see spend data here.
        </div>
      ) : (
        <CostCharts
          daily={daily}
          topAgents={summary.topAgents}
          topModels={summary.topModels}
        />
      )}
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4">
      <div className="text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
