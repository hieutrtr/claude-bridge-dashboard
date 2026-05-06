// P3-T1 — `/loops` page. Server component; reads filter state from
// the URL `searchParams`, calls `loops.list` via tRPC `createCaller`,
// and renders a paginated table. URL is the single source of truth —
// the filter strip is a plain `<form method="get">`. Submitting drops
// the cursor param implicitly (jumps back to page 1).
//
// Read-only — no MCP, no mutations, no `"use client"` directive. The
// "Start loop" dialog (P3-T3) and per-row cancel control (P3-T4) plug
// into this same page in later iterations.

import { appRouter } from "@/src/server/routers/_app";
import { LoopFilters } from "@/src/components/loop-filters";
import { LoopTable } from "@/src/components/loop-table";

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

function buildSearchString(
  params: Record<string, string | null>,
  override?: { cursor?: string },
): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value.length > 0) {
      usp.set(key, value);
    }
  }
  if (override?.cursor !== undefined) {
    usp.set("cursor", override.cursor);
  }
  const s = usp.toString();
  return s.length > 0 ? `?${s}` : "";
}

export default async function LoopsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = readString(sp.status);
  const agent = readString(sp.agent);
  const cursor = readString(sp.cursor);

  const caller = appRouter.createCaller({});
  const page = await caller.loops.list({
    ...(status !== null ? { status } : {}),
    ...(agent !== null ? { agent } : {}),
    ...(cursor !== null ? { cursor } : {}),
    limit: 50,
  });

  const isFiltered = status !== null || agent !== null;
  const baseParams = { status, agent };
  const buildNextHref = (nextCursor: string) =>
    `/loops${buildSearchString(baseParams, { cursor: nextCursor })}`;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Loops</h1>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          All goal loops across every agent. Filter by status or agent;
          pagination keeps each page at 50 rows (most recent first).
        </p>
      </header>

      <LoopFilters status={status} agent={agent} />

      <LoopTable
        items={page.items}
        nextCursor={page.nextCursor}
        buildNextHref={buildNextHref}
        isFiltered={isFiltered}
      />
    </div>
  );
}
