// P3-T5 — `/schedules` page. Server component; reads filter state from
// the URL `searchParams`, calls `schedules.list` via tRPC `createCaller`,
// and renders a table. URL is the single source of truth — the filter
// strip is a plain `<form method="get">`.
//
// Read-only — no MCP, no mutations, no `"use client"` directive. The
// "New schedule" dialog (P3-T6) and per-row pause/resume/delete
// controls (P3-T7) plug into this page in later iterations.

import { appRouter } from "@/src/server/routers/_app";
import { getSessionSubject } from "@/src/server/session";
import { ScheduleFilters } from "@/src/components/schedule-filters";
import { ScheduleTable } from "@/src/components/schedule-table";
import {
  ScheduleCreateDialog,
  ScheduleCreateTrigger,
} from "@/src/components/schedule-create-dialog";
import { ScheduleRunsDrawer } from "@/src/components/schedule-runs-drawer";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readString(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export default async function SchedulesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const agent = readString(sp.agent);

  const userId = await getSessionSubject();
  const caller = appRouter.createCaller({ userId });
  const page = await caller.schedules.list({
    ...(agent !== null ? { agent } : {}),
  });

  const isFiltered = agent !== null;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Schedules</h1>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            Recurring schedules across every agent. Soonest fire-time
            first; paused schedules drop to the bottom.
          </p>
        </div>
        <ScheduleCreateTrigger />
      </header>

      <ScheduleFilters agent={agent} />

      <ScheduleTable items={page.items} isFiltered={isFiltered} />

      <ScheduleCreateDialog />
      <ScheduleRunsDrawer />
    </div>
  );
}
