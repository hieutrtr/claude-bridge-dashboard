// T11 — root loading skeleton. Rendered by the App Router while the
// segment's server component is awaiting async data. Layout-shape
// enough to absorb the FCP budget (v1 ARCH §11 — < 200 ms) without
// shifting once the real content lands.

import { Skeleton } from "@/src/components/ui/skeleton";

export default function RootLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    </div>
  );
}
