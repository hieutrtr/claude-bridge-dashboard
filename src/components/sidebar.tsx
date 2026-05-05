"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, isNavActive } from "@/src/lib/nav";
import { cn } from "@/src/lib/utils";

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  return (
    <aside
      aria-label="Primary navigation"
      className="flex h-screen w-56 shrink-0 flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-4"
    >
      <div className="mb-6 px-2 text-sm font-semibold tracking-tight">
        Claude Bridge
      </div>
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-[hsl(var(--card))] text-[hsl(var(--foreground))]"
                  : "text-[hsl(var(--foreground))]/60 hover:bg-[hsl(var(--card))] hover:text-[hsl(var(--foreground))]",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
