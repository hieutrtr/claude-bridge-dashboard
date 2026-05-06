// P3-T5 — `/schedules` page filter strip. URL-as-truth pattern from
// `<LoopFilters>` / `<TaskFilters>`: a plain `<form method="get">`
// with a single agent input. Submitting drops any cursor implicitly.
//
// Schedules don't have an explicit "status" column — the daemon's
// `enabled` flag toggles between active and paused. Filter UX for that
// lands in T7 (when pause/resume mutations exist); T5 keeps the filter
// strip narrow.

import Link from "next/link";

export interface ScheduleFiltersProps {
  agent: string | null;
}

export function ScheduleFilters({ agent }: ScheduleFiltersProps) {
  return (
    <form
      method="get"
      action="/schedules"
      className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4"
      aria-label="Schedule filters"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          href="/schedules"
          className="h-9 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--muted))]"
        >
          Clear
        </Link>
      </div>
    </form>
  );
}
