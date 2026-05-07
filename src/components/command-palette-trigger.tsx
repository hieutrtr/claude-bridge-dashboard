"use client";

// P4-T05 — small ⌘K button for the topbar. Mirrors the
// `<DispatchTrigger>` pattern: clicking dispatches a custom event;
// the palette wrapper (mounted once in `app/layout.tsx`) owns the
// open-state authority. Same shortcut chip as before — but now it
// opens the palette, not the dispatch dialog.

import { Button } from "@/src/components/ui/button";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/src/components/command-palette";

export function CommandPaletteTrigger() {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
      }}
      aria-label="Open command palette (Cmd+K)"
      className="h-11 w-full gap-2 sm:h-9 sm:w-auto"
    >
      <span>Search</span>
      <kbd className="hidden rounded border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))] sm:inline-block">
        ⌘K
      </kbd>
    </Button>
  );
}
