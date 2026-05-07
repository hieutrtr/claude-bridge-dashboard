"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, isNavActive } from "@/src/lib/nav";
import { useT } from "@/src/i18n/client";
import { cn } from "@/src/lib/utils";

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const t = useT();
  return (
    <aside
      aria-label={t("nav.primary_label")}
      data-role="desktop-sidebar"
      className="hidden h-screen w-56 shrink-0 flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-4 md:flex"
    >
      <div className="mb-6 px-2 text-sm font-semibold tracking-tight">
        {t("app.name")}
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
                "flex h-11 items-center rounded-md px-3 text-sm transition-colors md:h-9",
                active
                  ? "bg-[hsl(var(--card))] text-[hsl(var(--foreground))]"
                  : "text-[hsl(var(--foreground))]/60 hover:bg-[hsl(var(--card))] hover:text-[hsl(var(--foreground))]",
              )}
            >
              {t(item.i18nKey)}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
