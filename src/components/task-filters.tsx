// T05 — global Tasks page filter strip. Plain `<form method="get">`
// so the URL stays the single source of truth — no `"use client"`,
// no React state, no JS required to filter. Submitting the form
// drops the cursor param implicitly (the Next link is the only
// place that sets it), which is the desired UX: changing filters
// jumps back to page 1.

import Link from "next/link";

// Status values surfaced in the daemon `tasks.status` column. Matches
// `task-status.ts` (T04) plus an "All" sentinel that maps to no filter.
const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "killed", label: "Killed" },
];

export interface TaskFiltersProps {
  status: string | null;
  agentName: string | null;
  channel: string | null;
  since: string | null;
  until: string | null;
}

export function TaskFilters({
  status,
  agentName,
  channel,
  since,
  until,
}: TaskFiltersProps) {
  return (
    <form
      method="get"
      action="/tasks"
      className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4"
      aria-label="Task filters"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
            name="agentName"
            defaultValue={agentName ?? ""}
            placeholder="exact match"
            className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">Channel</span>
          <input
            type="text"
            name="channel"
            defaultValue={channel ?? ""}
            placeholder="cli / telegram / …"
            className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">
            Since (created_at ≥)
          </span>
          <input
            type="text"
            name="since"
            defaultValue={since ?? ""}
            placeholder="2026-05-05 09:00:00"
            className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 font-mono text-xs"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">
            Until (created_at ≤)
          </span>
          <input
            type="text"
            name="until"
            defaultValue={until ?? ""}
            placeholder="2026-05-05 23:59:59"
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
          href="/tasks"
          className="h-9 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--muted))]"
        >
          Clear
        </Link>
      </div>
    </form>
  );
}
