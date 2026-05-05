import * as React from "react";
import { cn } from "@/src/lib/utils";

type DivProps = React.HTMLAttributes<HTMLDivElement> & {
  ref?: React.Ref<HTMLDivElement>;
};

export function Skeleton({ className, ref, ...props }: DivProps) {
  return (
    <div
      ref={ref}
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "animate-pulse rounded-md bg-[hsl(var(--muted))]",
        className,
      )}
      {...props}
    />
  );
}
