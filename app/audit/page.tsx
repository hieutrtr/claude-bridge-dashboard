// P2-T05 — `/audit` page. Server component; reads filter state from
// the URL `searchParams`, calls `audit.list` via tRPC `createCaller`,
// and renders a paginated table. URL is the single source of truth —
// the filter strip is a plain `<form method="get">`.
//
// Owner-only: the page sits inside the same auth-middleware-gated
// shell as every other dashboard route. Phase 2 has no role concept;
// procedure-level role checks are deferred to Phase 4 multi-user work.

import { appRouter } from "@/src/server/routers/_app";
import { getSessionSubject } from "@/src/server/session";
import { AuditFilters } from "@/src/components/audit-filters";
import { AuditLogTable } from "@/src/components/audit-log-table";

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

function readMsEpoch(raw: string | string[] | undefined): number | undefined {
  const value = readString(raw);
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
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

export default async function AuditPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const action = readString(sp.action);
  const resourceType = readString(sp.resourceType);
  const userId = readString(sp.userId);
  const sinceStr = readString(sp.since);
  const untilStr = readString(sp.until);
  const since = readMsEpoch(sp.since);
  const until = readMsEpoch(sp.until);
  const cursor = readCursor(sp.cursor);

  const callerSubject = await getSessionSubject();
  const caller = appRouter.createCaller({ userId: callerSubject });
  const page = await caller.audit.list({
    ...(action !== null ? { action } : {}),
    ...(resourceType !== null ? { resourceType } : {}),
    ...(userId !== null ? { userId } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    limit: 100,
  });

  const isFiltered =
    action !== null ||
    resourceType !== null ||
    userId !== null ||
    sinceStr !== null ||
    untilStr !== null;

  const baseParams = {
    action,
    resourceType,
    userId,
    since: sinceStr,
    until: untilStr,
  };
  const buildNextHref = (nextCursor: number) =>
    `/audit${buildSearchString(baseParams, { cursor: nextCursor })}`;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          Every dashboard mutation (dispatch, kill, loop approve/reject)
          and every rejected guard request (CSRF, rate limit) is recorded
          here. Filter by action, resource, user, or date range; pages
          show 100 rows (newest first).
        </p>
      </header>

      <AuditFilters
        action={action}
        resourceType={resourceType}
        userId={userId}
        since={sinceStr}
        until={untilStr}
      />

      <AuditLogTable
        items={page.items}
        nextCursor={page.nextCursor}
        buildNextHref={buildNextHref}
        isFiltered={isFiltered}
      />
    </div>
  );
}
