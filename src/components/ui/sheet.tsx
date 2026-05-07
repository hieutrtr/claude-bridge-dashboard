"use client";

// P4-T07 — Minimal accessible drawer ("Sheet") for the mobile nav. We
// stay headless instead of pulling in Radix because the dashboard only
// needs one drawer surface (the mobile nav); shipping radix-ui pulls
// 20kb of runtime + a peer-dep matrix that we'd otherwise be dragging
// in for a single component.
//
// Behaviour contract:
//   * Renders a fixed overlay + a sliding panel anchored to a side.
//   * Closes on ESC, on backdrop click, on a child calling `onClose`.
//   * Locks body scroll while open (prevents background scroll on
//     iOS Safari behind the drawer).
//   * Restores focus to whatever was focused before opening.
//   * `aria-modal="true"`, `role="dialog"` so screen readers announce.
//   * Initial focus moves to the close button so the panel is keyboard-
//     navigable from the very first tab.
//
// The component is deliberately *uncontrolled-ish*: parents pass
// `open` + `onOpenChange` so the page-level routing layer can close the
// drawer on navigation (see `MobileNavDrawer`).

import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
} from "react";

import { cn } from "@/src/lib/utils";

export type SheetSide = "left" | "right";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: SheetSide;
  /** Accessible label — required because the panel has no visible title by default. */
  ariaLabel: string;
  /** Optional id of an element inside the panel that titles it. Wins over ariaLabel. */
  ariaLabelledBy?: string;
  /** Tailwind width utilities for the panel (e.g. `w-72`). */
  panelClassName?: string;
  /** Children are rendered inside the panel. */
  children: ReactNode;
  /** Test/data hook applied to the panel root. */
  dataRole?: string;
}

export function Sheet(props: SheetProps) {
  const {
    open,
    onOpenChange,
    side = "left",
    ariaLabel,
    ariaLabelledBy,
    panelClassName,
    children,
    dataRole,
  } = props;
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Body scroll lock while open + focus restore on close.
  useEffect(() => {
    if (!open) return;
    if (typeof document === "undefined") return;
    previousFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus the close button so the drawer is keyboard-navigable.
    queueMicrotask(() => closeBtnRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  // ESC closes; trap focus within the panel.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabelledBy ? undefined : ariaLabel}
      aria-labelledby={ariaLabelledBy ?? titleId}
      className="fixed inset-0 z-50 flex"
      data-role={dataRole}
    >
      <div
        aria-hidden="true"
        onClick={close}
        data-role="sheet-backdrop"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        data-role="sheet-panel"
        data-side={side}
        className={cn(
          "relative z-10 flex h-full flex-col border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-xl",
          side === "left" ? "border-r" : "ml-auto border-l",
          panelClassName ?? "w-72",
        )}
      >
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2">
          {/* Hidden default title for SR users when no labelledBy prop is provided. */}
          {ariaLabelledBy ? null : (
            <span id={titleId} className="sr-only">
              {ariaLabel}
            </span>
          )}
          <span aria-hidden="true" className="text-sm font-semibold">
            {ariaLabel}
          </span>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={close}
            data-role="sheet-close"
            aria-label="Close menu"
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--card))] hover:text-[hsl(var(--foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-3">{children}</div>
      </div>
    </div>
  );
}
