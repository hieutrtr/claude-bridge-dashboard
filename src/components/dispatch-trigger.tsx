"use client";

// P2-T02 — small "Dispatch" button that lives in the topbar. Decoupled
// from the dialog: clicking dispatches a `bridge:open-dispatch` custom
// event on the window. The dialog (mounted once in the topbar) listens
// for the event and opens. Same pathway as the global ⌘K hotkey, so
// this control + the keystroke share a single open-state authority.

import { Button } from "@/src/components/ui/button";
import { OPEN_DISPATCH_EVENT } from "@/src/components/dispatch-dialog";

export function DispatchTrigger() {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(OPEN_DISPATCH_EVENT));
      }}
      aria-label="Open dispatch dialog (Cmd+K)"
      className="gap-2"
    >
      <span>Dispatch</span>
      <kbd className="rounded border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
        ⌘K
      </kbd>
    </Button>
  );
}
