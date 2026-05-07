"use client";

// P4-T07 — Mobile nav drawer + hamburger trigger. Renders an inline
// `<button>` (the hamburger) at viewports below `md`; clicking opens
// the `<Sheet>` with the same `NAV_ITEMS` the desktop sidebar shows.
// The drawer auto-closes when the route changes (so the next page is
// reachable without a second tap), and the trigger keeps a stable 44×44
// touch-target (T07 acceptance, WCAG 2.5.5 AAA / Apple HIG).

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Sheet } from "@/src/components/ui/sheet";
import { NAV_ITEMS, isNavActive } from "@/src/lib/nav";
import { shouldCloseOnPathChange } from "@/src/lib/mobile-nav";
import { useT } from "@/src/i18n/client";
import { cn } from "@/src/lib/utils";

export function MobileNav() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const previousPath = useRef<string>(pathname);
  const t = useT();

  useEffect(() => {
    if (shouldCloseOnPathChange(previousPath.current, pathname, open)) {
      setOpen(false);
    }
    previousPath.current = pathname;
  }, [pathname, open]);

  return (
    <>
      <button
        type="button"
        data-role="mobile-nav-trigger"
        aria-label={t("topbar.menu")}
        aria-expanded={open}
        aria-controls="mobile-nav-drawer"
        onClick={() => setOpen(true)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--card))] hover:text-[hsl(var(--foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] md:hidden"
      >
        <span aria-hidden="true" className="block">
          {/* Three-line glyph drawn with three flexed bars; no SVG dep. */}
          <span className="flex flex-col items-center gap-[3px]">
            <span className="block h-[2px] w-5 bg-current" />
            <span className="block h-[2px] w-5 bg-current" />
            <span className="block h-[2px] w-5 bg-current" />
          </span>
        </span>
      </button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        ariaLabel={`${t("app.name")} ${t("nav.primary_label").toLowerCase()}`}
        side="left"
        panelClassName="w-72"
        dataRole="mobile-nav-drawer"
      >
        <nav
          id="mobile-nav-drawer"
          aria-label={t("nav.primary_label")}
          className="flex flex-col gap-1"
        >
          {NAV_ITEMS.map((item) => {
            const active = isNavActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                data-role="mobile-nav-link"
                className={cn(
                  "flex h-11 items-center rounded-md px-3 text-sm transition-colors",
                  active
                    ? "bg-[hsl(var(--card))] text-[hsl(var(--foreground))]"
                    : "text-[hsl(var(--foreground))]/70 hover:bg-[hsl(var(--card))] hover:text-[hsl(var(--foreground))]",
                )}
              >
                {t(item.i18nKey)}
              </Link>
            );
          })}
        </nav>
      </Sheet>
    </>
  );
}
