import * as React from "react";
import { cn } from "@/src/lib/utils";

type DivProps = React.HTMLAttributes<HTMLDivElement> & { ref?: React.Ref<HTMLDivElement> };

export function Card({ className, ref, ...props }: DivProps) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--card-foreground))] shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ref, ...props }: DivProps) {
  return (
    <div
      ref={ref}
      className={cn("flex flex-col space-y-1.5 p-6", className)}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { ref?: React.Ref<HTMLHeadingElement> }) {
  return (
    <h3
      ref={ref}
      className={cn("text-lg font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ref, ...props }: DivProps) {
  return <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />;
}
