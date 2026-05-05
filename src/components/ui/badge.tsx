import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/src/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        running:
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        idle:
          "border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]",
        error:
          "border-red-500/30 bg-red-500/10 text-red-400",
        unknown:
          "border-[hsl(var(--border))] bg-transparent text-[hsl(var(--muted-foreground))]",
      },
    },
    defaultVariants: { variant: "unknown" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
