"use client";

// P2-T02 — small "Dispatch" button that lives in the topbar. Decoupled
// from the dialog: clicking dispatches a `bridge:open-dispatch` custom
// event on the window. The dialog (mounted once in the topbar) listens
// for the event and opens.
//
// P4-T05 update: the global ⌘K hotkey now opens the command palette
// (which exposes "Dispatch task to agent…" as one of its commands).
// This button stays as a topbar shortcut for users who prefer click +
// for discoverability of the dispatch flow.

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
      aria-label="Open dispatch dialog"
      className="h-11 gap-2 sm:h-9"
    >
      <span>Dispatch</span>
    </Button>
  );
}
