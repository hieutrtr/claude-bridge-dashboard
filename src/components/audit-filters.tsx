// P2-T05 — `/audit` filter strip. Same pattern as <TaskFilters>:
// `<form method="get">` → URL is the single source of truth, no
// `"use client"`, no React state, no JS required.
//
// `since`/`until` accept ms-epoch strings. The empty action enumeration
// (T01..T09 each invent labels independently) means the filter is a
// free-text input, not a `<select>`.

import Link from "next/link";

export interface AuditFiltersProps {
  action: string | null;
  resourceType: string | null;
  userId: string | null;
  since: string | null;
  until: string | null;
}

export function AuditFilters({
  action,
  resourceType,
  userId,
  since,
  until,
}: AuditFiltersProps) {
  return (
    <form
      method="get"
      action="/audit"
      className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4"
      aria-label="Audit log filters"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">Action</span>
          <input
            type="text"
            name="action"
            defaultValue={action ?? ""}
            placeholder="task.dispatch / csrf_invalid / …"
            className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 font-mono text-xs"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">
            Resource type
          </span>
          <input
            type="text"
            name="resourceType"
            defaultValue={resourceType ?? ""}
            placeholder="task / loop / auth / …"
            className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 font-mono text-xs"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">User</span>
          <input
            type="text"
            name="userId"
            defaultValue={userId ?? ""}
            placeholder='owner / "<anonymous>"'
            className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">
            Since (ms epoch)
          </span>
          <input
            type="text"
            name="since"
            defaultValue={since ?? ""}
            inputMode="numeric"
            placeholder="1700000000000"
            className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 font-mono text-xs"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">
            Until (ms epoch)
          </span>
          <input
            type="text"
            name="until"
            defaultValue={until ?? ""}
            inputMode="numeric"
            placeholder="1700000000000"
            className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 font-mono text-xs"
          />
        </label>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="submit"
          className="h-9 rounded-md bg-[hsl(var(--foreground))] px-4 text-sm font-medium text-[hsl(var(--background))] hover:opacity-90"
        >
          Apply
        </button>
        <Link
          href="/audit"
          className="h-9 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--muted))]"
        >
          Clear
        </Link>
      </div>
    </form>
  );
}
