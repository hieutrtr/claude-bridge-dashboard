// P2-T05 — `/audit` table. Pure presentational; the page server
// component fetches `audit.list` via tRPC createCaller and hands rows
// down. Pagination at 100 rows/page (vs <GlobalTaskTable>'s 50)
// matches the audit reader's larger limit ceiling.
//
// `payloadJson` is rendered raw inside a `<pre>`; T04 already redacted
// `password` keys at write-time, so the viewer is no laxer than the
// writer. The cell collapses to a hover-expand on overflow so a long
// payload doesn't steal vertical real-estate from the table.

import Link from "next/link";

import type { AuditLogRow } from "@/src/server/dto";
import { Card, CardContent } from "@/src/components/ui/card";

const PAYLOAD_TRUNCATE = 80;
const REQUEST_ID_PREFIX = 8;
const IP_HASH_PREFIX = 8;

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

function formatCreatedAt(ms: number): string {
  // Render both an absolute UTC date (operator-friendly for cross-system
  // forensics) and a relative hint. Relative is rounded down per unit so
  // `0 s ago` reads sensibly.
  const d = new Date(ms);
  const iso = d.toISOString().slice(0, 19).replace("T", " ") + "Z";
  const deltaSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  let rel: string;
  if (deltaSec < 60) rel = `${deltaSec}s ago`;
  else if (deltaSec < 3600) rel = `${Math.floor(deltaSec / 60)}m ago`;
  else if (deltaSec < 86_400) rel = `${Math.floor(deltaSec / 3600)}h ago`;
  else rel = `${Math.floor(deltaSec / 86_400)}d ago`;
  return `${iso} (${rel})`;
}

export interface AuditLogTableProps {
  items: AuditLogRow[];
  nextCursor: number | null;
  buildNextHref: (cursor: number) => string;
  isFiltered: boolean;
}

export function AuditLogTable({
  items,
  nextCursor,
  buildNextHref,
  isFiltered,
}: AuditLogTableProps) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {isFiltered ? (
              <>
                No audit rows match the current filters. Adjust them above
                or{" "}
                <Link
                  href="/audit"
                  className="underline hover:text-[hsl(var(--foreground))]"
                >
                  clear all
                </Link>
                .
              </>
            ) : (
              <>
                No audit rows recorded yet. Mutations (dispatch, kill, loop
                approve/reject) and rejected guard requests (CSRF, rate
                limit) will appear here.
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
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Resource</th>
              <th className="px-3 py-2 font-medium">Payload</th>
              <th className="px-3 py-2 font-medium">IP hash</th>
              <th className="px-3 py-2 font-medium">Req id</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const payloadDisplay =
                row.payloadJson === null
                  ? "—"
                  : truncate(row.payloadJson, PAYLOAD_TRUNCATE);
              const resource =
                row.resourceId === null
                  ? row.resourceType
                  : `${row.resourceType}:${row.resourceId}`;
              return (
                <tr
                  key={row.id}
                  className="border-t border-[hsl(var(--border))]"
                >
                  <td className="px-3 py-2 font-mono text-xs">{row.id}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatCreatedAt(row.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    {row.userId ?? (
                      <span className="text-[hsl(var(--muted-foreground))]">
                        &lt;anonymous&gt;
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{row.action}</td>
                  <td className="px-3 py-2 font-mono text-xs">{resource}</td>
                  <td
                    className="max-w-[28rem] truncate px-3 py-2 font-mono text-xs"
                    title={row.payloadJson ?? undefined}
                  >
                    {payloadDisplay}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.ipHash === null
                      ? "—"
                      : row.ipHash.slice(0, IP_HASH_PREFIX) + "…"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.requestId === null
                      ? "—"
                      : row.requestId.slice(0, REQUEST_ID_PREFIX) + "…"}
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
