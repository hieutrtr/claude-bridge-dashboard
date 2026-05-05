// T11 — `/agents` route skeleton. Mirrors the agents grid layout (4-up
// on xl, 3-up on lg, 2-up on sm) so the placeholder shape matches what
// `<AgentsGrid>` will render once `agents.list` resolves.

import { Skeleton } from "@/src/components/ui/skeleton";

export default function AgentsLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-32" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
    </div>
  );
}
