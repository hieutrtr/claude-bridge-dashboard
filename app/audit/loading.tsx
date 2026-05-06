// P2-T05 — `/audit` route skeleton. Mirrors the layout: heading,
// 5-input filter strip, 100-row paginated table — render 8 placeholder
// row strips so the height budget is roughly stable when data resolves.

import { Skeleton } from "@/src/components/ui/skeleton";

export default function AuditLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-40" />
        ))}
      </div>
      <div className="space-y-1 rounded-lg border border-[hsl(var(--border))] p-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}
