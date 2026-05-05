"use client";

// T09 — client leaf wrapping the three Recharts primitives. Imported by
// `app/cost/page.tsx`; kept as a separate component so the rest of the
// page stays a server component (KPIs + empty state ship in the initial
// HTML for the FCP budget).
//
// Pure render: data lives in props, no `useState`, no `useEffect`. The
// only client-side reason for the boundary is Recharts using browser
// measurements via `<ResponsiveContainer>`.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  CostSummaryAgentRow,
  CostSummaryModelRow,
  DailyCostPoint,
} from "@/src/server/dto";

interface CostChartsProps {
  daily: DailyCostPoint[];
  topAgents: CostSummaryAgentRow[];
  topModels: CostSummaryModelRow[];
}

// 5 stable colour slots — one per pie / bar slice. Tailwind v4 design
// tokens use HSL channels, but Recharts wants concrete strings; matching
// the existing badge palette (T03/T05) here.
const SLICE_COLORS = ["#0ea5e9", "#22c55e", "#a855f7", "#f97316", "#ec4899"];

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function CostCharts({ daily, topAgents, topModels }: CostChartsProps) {
  const lineData = daily.map((d) => ({ day: d.day, cost: d.costUsd }));
  const agentData = topAgents.map((a) => ({
    name: a.agentName ?? "(unknown)",
    cost: a.costUsd,
  }));
  const modelData = topModels.map((m) => ({
    name: m.model ?? "(unknown)",
    cost: m.costUsd,
  }));

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 lg:col-span-2">
        <h2 className="mb-3 text-sm font-medium text-[hsl(var(--muted-foreground))]">
          Daily spend (last 30 days)
        </h2>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={lineData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtUsd} />
              <Tooltip formatter={(v: number) => fmtUsd(v)} />
              <Line type="monotone" dataKey="cost" stroke={SLICE_COLORS[0]} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4">
        <h2 className="mb-3 text-sm font-medium text-[hsl(var(--muted-foreground))]">
          Spend per agent (top 5)
        </h2>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Tooltip formatter={(v: number) => fmtUsd(v)} />
              <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 11 }} />
              <Pie
                data={agentData}
                dataKey="cost"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius="70%"
                label={(entry) => fmtUsd(entry.cost as number)}
              >
                {agentData.map((_, i) => (
                  <Cell key={i} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4">
        <h2 className="mb-3 text-sm font-medium text-[hsl(var(--muted-foreground))]">
          Spend per model (top 5)
        </h2>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={modelData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtUsd} />
              <Tooltip formatter={(v: number) => fmtUsd(v)} />
              <Bar dataKey="cost" fill={SLICE_COLORS[2]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
