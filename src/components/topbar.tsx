import { ThemeToggle } from "@/src/components/ui/theme-toggle";
import { DispatchDialog } from "@/src/components/dispatch-dialog";
import { DispatchTrigger } from "@/src/components/dispatch-trigger";
import { CommandPaletteTrigger } from "@/src/components/command-palette-trigger";
import { MobileNav } from "@/src/components/mobile-nav";

export function Topbar() {
  // P4-T05: the disabled "Search…" input was a Phase-1 placeholder for
  // the global search. The command palette delivers the actual surface,
  // so the input is replaced with `<CommandPaletteTrigger>`.
  // P4-T07: header is now `sticky top-0` so it stays in view while the
  // main column scrolls on mobile, and a `<MobileNav>` hamburger is
  // rendered below `md` (the desktop sidebar collapses there).
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background))]/75 sm:gap-3 sm:px-4">
      <MobileNav />
      <div className="min-w-0 flex-1">
        <CommandPaletteTrigger />
      </div>
      <DispatchTrigger />
      <ThemeToggle />
      {/*
        Decorative user-menu placeholder. axe-core (T10) flags an
        aria-label on a non-interactive <div> with no role; the
        avatar disc is presentational only — the real menu lands in
        v0.2.0 — so we drop the aria-label and keep it `aria-hidden`.
      */}
      <div
        aria-hidden="true"
        className="ml-1 hidden h-8 w-8 shrink-0 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))] sm:block"
      />
      <DispatchDialog />
    </header>
  );
}
