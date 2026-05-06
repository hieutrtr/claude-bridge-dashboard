// P3-T1 — `/loops` page filter strip. URL-as-truth pattern inherited
// from `<TaskFilters>` (Phase 1 T05 / Phase 2): a plain `<form
// method="get">` so no `"use client"` directive, no React state, no
// JS required to filter. Submitting the form drops the cursor param
// implicitly — changing filters jumps back to page 1.
//
// `status="waiting_approval"` is a synthetic option (the daemon
// keeps the column at "running" while waiting on a human gate); the
// router maps the sentinel to `pending_approval=true`.

import Link from "next/link";

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "waiting_approval", label: "Waiting approval" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
  { value: "failed", label: "Failed" },
];

export interface LoopFiltersProps {
  status: string | null;
  agent: string | null;
}

export function LoopFilters({ status, agent }: LoopFiltersProps) {
  return (
    <form
      method="get"
      action="/loops"
      className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4"
      aria-label="Loop filters"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">Status</span>
          <select
            name="status"
            defaultValue={status ?? ""}
            className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">Agent name</span>
          <input
            type="text"
            name="agent"
            defaultValue={agent ?? ""}
            placeholder="exact match"
            className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
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
          href="/loops"
          className="h-9 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--muted))]"
        >
          Clear
        </Link>
      </div>
    </form>
  );
}
