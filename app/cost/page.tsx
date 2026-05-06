// T09 — Cost analytics page (Phase 1) + T04 (Phase 4) "By user" tab.
//
// Server component; calls `analytics.summary({ window })` plus EITHER
// `analytics.dailyCost({})` (default tab) OR `analytics.costByUser({
// window })` (`?tab=user`) via the in-process tRPC `createCaller` (no
// HTTP roundtrip). KPI numbers, the empty state, the tab strip, and
// the leaderboard are rendered server-side; only the three Recharts
// primitives ship as a client leaf (`<CostCharts>`) because they need
// browser layout measurement via `<ResponsiveContainer>`.
//
// Read-only: page issues only tRPC `query` procedures. No mutations,
// no dispatch, no DB writes — guard mirrors T05/T06/T07/T08.

import type { ReactElement } from "react";
import Link from "next/link";

import { appRouter } from "@/src/server/routers/_app";
import { getSessionSubject } from "@/src/server/session";
import { CostCharts } from "@/src/components/cost-charts";
import { CostByUser } from "@/src/components/cost-by-user";

export const dynamic = "force-dynamic";

const WINDOWS = ["24h", "7d", "30d"] as const;
type Window = (typeof WINDOWS)[number];

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatSinceDate(iso: string): string {
  // SQLite's datetime('now', '-30 days') returns 'YYYY-MM-DD HH:MM:SS'.
  // The page header shows just the date.
  return iso.split(" ")[0] ?? iso;
}

function parseTab(raw: string | string[] | undefined): "day" | "user" {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "user" ? "user" : "day";
}

function parseWindow(raw: string | string[] | undefined): Window {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (WINDOWS as readonly string[]).includes(v ?? "")
    ? (v as Window)
    : "30d";
}

interface CostPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CostPage({ searchParams }: CostPageProps) {
  const sp = (await searchParams) ?? {};
  const tab = parseTab(sp.tab);
  const window = parseWindow(sp.window);

  const userId = await getSessionSubject();
  const caller = appRouter.createCaller({ userId });

  const summary = await caller.analytics.summary({ window });
  const isEmpty = summary.totalTasks === 0;

  // Resolve the active tab payload eagerly so the page is fully sync-
  // renderable for `renderToStaticMarkup` consumers (test harness +
  // anything that pre-renders without React Suspense). Whichever tab
  // is active dictates the second tRPC query — we never fetch both.
  let body: ReactElement;
  if (tab === "user") {
    const payload = await caller.analytics.costByUser({ window });
    body = <CostByUser payload={payload} />;
  } else if (isEmpty) {
    body = <EmptyDayTab />;
  } else {
    const daily = await caller.analytics.dailyCost({});
    body = (
      <CostCharts
        daily={daily}
        topAgents={summary.topAgents}
        topModels={summary.topModels}
      />
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Cost</h1>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          Spend over the last {windowLabel(window)} (since{" "}
          {formatSinceDate(summary.since)}). Read-only; numbers match{" "}
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

      <CostTabs activeTab={tab} window={window} />

      {body}
    </div>
  );
}

function EmptyDayTab() {
  return (
    <div className="rounded-lg border border-dashed border-[hsl(var(--border))] p-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
      No completed tasks yet — run a task with{" "}
      <code className="rounded bg-[hsl(var(--muted))] px-1 py-0.5 text-xs">
        bridge dispatch
      </code>{" "}
      to see spend data here.
    </div>
  );
}

function windowLabel(w: Window): string {
  switch (w) {
    case "24h":
      return "24 hours";
    case "7d":
      return "7 days";
    case "30d":
      return "30 days";
  }
}

function CostTabs({
  activeTab,
  window,
}: {
  activeTab: "day" | "user";
  window: Window;
}) {
  const tabs: Array<{ key: "day" | "user"; label: string; href: string }> = [
    { key: "day", label: "By day", href: hrefFor({ tab: "day", window }) },
    {
      key: "user",
      label: "By user",
      href: hrefFor({ tab: "user", window }),
    },
  ];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--border))]">
      <nav aria-label="Cost view" className="-mb-px flex gap-2">
        {tabs.map((t) => {
          const active = t.key === activeTab;
          return (
            <Link
              key={t.key}
              href={t.href}
              className={
                "border-b-2 px-3 py-2 text-sm transition-colors " +
                (active
                  ? "border-[hsl(var(--foreground))] font-medium"
                  : "border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]")
              }
              aria-current={active ? "page" : undefined}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <WindowPicker activeTab={activeTab} window={window} />
    </div>
  );
}

function WindowPicker({
  activeTab,
  window,
}: {
  activeTab: "day" | "user";
  window: Window;
}) {
  return (
    <div role="group" aria-label="Window" className="flex gap-1 pb-2">
      {WINDOWS.map((w) => {
        const active = w === window;
        return (
          <Link
            key={w}
            href={hrefFor({ tab: activeTab, window: w })}
            className={
              "rounded px-2 py-1 text-xs transition-colors " +
              (active
                ? "bg-[hsl(var(--muted))] font-medium"
                : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]")
            }
            aria-current={active ? "true" : undefined}
          >
            {w}
          </Link>
        );
      })}
    </div>
  );
}

function hrefFor({
  tab,
  window,
}: {
  tab: "day" | "user";
  window: Window;
}): string {
  const params = new URLSearchParams();
  if (tab !== "day") params.set("tab", tab);
  if (window !== "30d") params.set("window", window);
  const qs = params.toString();
  return qs ? `/cost?${qs}` : "/cost";
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
