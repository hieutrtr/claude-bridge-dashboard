// T05 — global Tasks page. Server component; reads filter state from
// the URL `searchParams`, calls `tasks.list` via tRPC `createCaller`,
// and renders a paginated table. URL is the single source of truth —
// the filter strip is a plain `<form method="get">`. Submitting drops
// the cursor param implicitly (jumps back to page 1).
//
// Read-only: this page issues only a tRPC query. No mutations, no
// dispatch, no `"use client"` directive.

import { appRouter } from "@/src/server/routers/_app";
import { GlobalTaskTable } from "@/src/components/global-task-table";
import { TaskFilters } from "@/src/components/task-filters";

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

function readCursor(raw: string | string[] | undefined): number | undefined {
  const value = readString(raw);
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function buildSearchString(
  params: Record<string, string | null>,
  override?: { cursor?: number },
): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value.length > 0) {
      usp.set(key, value);
    }
  }
  if (override?.cursor !== undefined) {
    usp.set("cursor", String(override.cursor));
  }
  const s = usp.toString();
  return s.length > 0 ? `?${s}` : "";
}

export default async function TasksPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = readString(sp.status);
  const agentName = readString(sp.agentName);
  const channel = readString(sp.channel);
  const since = readString(sp.since);
  const until = readString(sp.until);
  const cursor = readCursor(sp.cursor);

  const caller = appRouter.createCaller({});
  const page = await caller.tasks.list({
    ...(status !== null ? { status } : {}),
    ...(agentName !== null ? { agentName } : {}),
    ...(channel !== null ? { channel } : {}),
    ...(since !== null ? { since } : {}),
    ...(until !== null ? { until } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    limit: 50,
  });

  const isFiltered =
    status !== null ||
    agentName !== null ||
    channel !== null ||
    since !== null ||
    until !== null;

  const baseParams = { status, agentName, channel, since, until };
  const buildNextHref = (nextCursor: number) =>
    `/tasks${buildSearchString(baseParams, { cursor: nextCursor })}`;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          All tasks across every agent. Filter by status, agent, channel, or
          date range; pagination keeps each page at 50 rows (most recent
          first).
        </p>
      </header>

      <TaskFilters
        status={status}
        agentName={agentName}
        channel={channel}
        since={since}
        until={until}
      />

      <GlobalTaskTable
        items={page.items}
        nextCursor={page.nextCursor}
        buildNextHref={buildNextHref}
        isFiltered={isFiltered}
      />
    </div>
  );
}
