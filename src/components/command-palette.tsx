"use client";

// P4-T05 — global ⌘K command palette. Opens via ⌘K / Ctrl+K from
// anywhere in the authed shell, via the topbar trigger button, or via
// a `bridge:open-command-palette` custom event. Selecting an action
// either navigates (`router.push`) or fires the matching dialog event
// (`bridge:open-dispatch`, `bridge:open-start-loop`, `bridge:open-
// schedule-create`) so this palette never duplicates the dialog
// state machines built in Phases 2 + 3.
//
// Two named exports:
//   * `CommandPaletteView` — pure props-driven markup; no hooks, no
//     event listeners, no `cmdk` import. Tests render this with
//     `renderToStaticMarkup` across the role + open + view-mode
//     matrix. The view mirrors the cmdk DOM shape (role="dialog",
//     <input cmdk-input />, ul/li result list) so the screenshots +
//     accessibility expectations hold even on the static path.
//   * `CommandPalette` — the wrapper that owns local state, the
//     ⌘K / `?` / `g` listeners, the cmdk-powered interactive shell,
//     and the action-dispatch layer.
//
// Static actions + role filtering live in `src/lib/command-palette.ts`
// — every behaviour the wrapper needs is unit-tested without a DOM.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";

import {
  STATIC_ACTIONS,
  HELP_SHORTCUTS,
  filterActionsForRole,
  groupActionsByCategory,
  isPaletteHotkey,
  isHelpHotkey,
  isLeaderKey,
  resolveLeaderShortcut,
  isFromEditableField,
  type PaletteAction,
  type Role,
} from "@/src/lib/command-palette";
import { OPEN_DISPATCH_EVENT } from "@/src/components/dispatch-dialog";
import { OPEN_START_LOOP_EVENT } from "@/src/components/start-loop-dialog";
import { OPEN_SCHEDULE_CREATE_EVENT } from "@/src/components/schedule-create-dialog";

export const OPEN_COMMAND_PALETTE_EVENT = "bridge:open-command-palette";

export type PaletteView = "actions" | "help";

export interface CommandPaletteViewProps {
  open: boolean;
  view: PaletteView;
  role: Role | null;
  query: string;
  onQueryChange?: (q: string) => void;
  onClose?: () => void;
  onSelect?: (action: PaletteAction) => void;
  onShowHelp?: () => void;
  onShowActions?: () => void;
}

/**
 * Pure render layer. Mirrors cmdk's DOM shape so the palette is
 * testable without jsdom. The interactive `<CommandPalette>` wraps
 * cmdk's `<Command.Dialog>` for the live experience.
 */
export function CommandPaletteView(props: CommandPaletteViewProps) {
  if (!props.open) return null;

  const filtered = filterActionsForRole(STATIC_ACTIONS, props.role);
  const groups = groupActionsByCategory(filtered);
  const queryLower = props.query.trim().toLowerCase();
  const matches = (action: PaletteAction): boolean => {
    if (queryLower.length === 0) return true;
    return (
      action.label.toLowerCase().includes(queryLower) ||
      (action.hint?.toLowerCase().includes(queryLower) ?? false)
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="command-palette-title"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-24"
    >
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-xl">
        <header className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-4 py-2">
          <h2
            id="command-palette-title"
            className="text-xs font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]"
          >
            {props.view === "help" ? "Keyboard shortcuts" : "Command palette"}
          </h2>
          <div className="flex items-center gap-2">
            {props.view === "help" ? (
              <button
                type="button"
                onClick={() => props.onShowActions?.()}
                className="rounded-md border border-[hsl(var(--border))] px-2 py-0.5 text-[10px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--card))]"
                aria-label="Back to commands"
              >
                Commands
              </button>
            ) : (
              <button
                type="button"
                onClick={() => props.onShowHelp?.()}
                className="rounded-md border border-[hsl(var(--border))] px-2 py-0.5 text-[10px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--card))]"
                aria-label="Show keyboard shortcuts"
              >
                ?
              </button>
            )}
            <button
              type="button"
              onClick={() => props.onClose?.()}
              className="rounded-md border border-[hsl(var(--border))] px-2 py-0.5 text-[10px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--card))]"
              aria-label="Close command palette"
            >
              Esc
            </button>
          </div>
        </header>

        {props.view === "help" ? (
          <HelpView />
        ) : (
          <>
            <div className="border-b border-[hsl(var(--border))] px-4 py-2">
              <input
                type="text"
                role="combobox"
                aria-controls="command-palette-list"
                aria-label="Search commands"
                placeholder="Type a command or search…"
                value={props.query}
                onChange={(e) => props.onQueryChange?.(e.target.value)}
                className="w-full bg-transparent text-sm outline-none placeholder:text-[hsl(var(--muted-foreground))]"
              />
            </div>

            <ul
              id="command-palette-list"
              role="listbox"
              className="max-h-96 overflow-y-auto py-1"
            >
              {groups.length === 0 ? (
                <li className="px-4 py-6 text-center text-xs text-[hsl(var(--muted-foreground))]">
                  No commands available — sign in first.
                </li>
              ) : null}
              {groups.map((group) => {
                const visible = group.actions.filter(matches);
                if (visible.length === 0) return null;
                return (
                  <li key={group.category} className="py-1">
                    <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                      {group.label}
                    </div>
                    <ul role="group" aria-label={group.label}>
                      {visible.map((action) => (
                        <li key={action.id}>
                          <button
                            type="button"
                            role="option"
                            data-action-id={action.id}
                            aria-selected="false"
                            onClick={() => props.onSelect?.(action)}
                            className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm hover:bg-[hsl(var(--card))] focus:bg-[hsl(var(--card))] focus:outline-none"
                          >
                            <span className="flex flex-col">
                              {/* Plain text only — labels enforced by assertSafeLabel */}
                              <span>{action.label}</span>
                              {action.hint ? (
                                <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                                  {action.hint}
                                </span>
                              ) : null}
                            </span>
                            {action.shortcut ? (
                              <span className="flex items-center gap-1">
                                {action.shortcut.map((k, i) => (
                                  <kbd
                                    key={`${action.id}-kbd-${i}`}
                                    className="rounded border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))]"
                                  >
                                    {k}
                                  </kbd>
                                ))}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
              {/* Empty-search result hint */}
              {queryLower.length > 0 &&
              groups.every((g) => g.actions.filter(matches).length === 0) ? (
                <li className="px-4 py-6 text-center text-xs text-[hsl(var(--muted-foreground))]">
                  No commands match "{props.query}".
                </li>
              ) : null}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function HelpView() {
  return (
    <div className="px-4 py-4">
      <p className="mb-3 text-xs text-[hsl(var(--muted-foreground))]">
        Hotkeys work everywhere except inside text fields.
      </p>
      <ul className="space-y-2">
        {HELP_SHORTCUTS.map((s) => (
          <li
            key={s.description}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span>{s.description}</span>
            <span className="flex items-center gap-1">
              {s.keys.map((k, i) => (
                <kbd
                  key={`${s.description}-${i}`}
                  className="rounded border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-1.5 py-0.5 font-mono text-[10px] text-[hsl(var(--muted-foreground))]"
                >
                  {k}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ----- Interactive wrapper ------------------------------------------------

const LEADER_TIMEOUT_MS = 1500;

export interface CommandPaletteProps {
  /** Caller role resolved server-side from `auth.me`. Null for anonymous. */
  role: Role | null;
}

export function CommandPalette({ role }: CommandPaletteProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PaletteView>("actions");
  const [query, setQuery] = useState("");

  // Leader-key state machine: `g` then second key within timeout → nav.
  // Stored in a ref so changes don't trigger renders / re-bind listeners.
  const leaderRef = useRef<{ at: number } | null>(null);
  // Remember which element had focus when the palette opens, so we can
  // restore focus to it after Esc / select. Also a ref — restoring is a
  // one-shot side effect, not render-driven.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const openPalette = useCallback(() => {
    if (open) return;
    if (typeof document !== "undefined") {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    setOpen(true);
    setView("actions");
    setQuery("");
  }, [open]);

  const closePalette = useCallback(() => {
    setOpen(false);
    // Restore focus to the element that had it before the palette opened.
    // If the element was inside an unmounted subtree, this no-ops safely.
    queueMicrotask(() => {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target && document.contains(target)) {
        try {
          target.focus({ preventScroll: true });
        } catch {
          // ignore — focus can throw on disabled elements
        }
      }
    });
  }, []);

  const dispatchAction = useCallback(
    (action: PaletteAction) => {
      switch (action.intent.type) {
        case "navigate":
          router.push(action.intent.href);
          closePalette();
          return;
        case "open-dispatch":
          closePalette();
          window.dispatchEvent(new CustomEvent(OPEN_DISPATCH_EVENT));
          return;
        case "open-start-loop":
          closePalette();
          window.dispatchEvent(new CustomEvent(OPEN_START_LOOP_EVENT));
          return;
        case "open-create-schedule":
          closePalette();
          window.dispatchEvent(new CustomEvent(OPEN_SCHEDULE_CREATE_EVENT));
          return;
        case "logout":
          closePalette();
          // Phase 1 logout is a CSRF-checked POST; redirect there.
          router.push("/api/auth/logout");
          return;
        case "toggle-theme":
          // T10 will wire this; for now just close + no-op.
          closePalette();
          return;
        case "switch-language":
          // T12 will wire this; for now just close + no-op.
          closePalette();
          return;
        case "show-help":
          setView("help");
          return;
      }
    },
    [router, closePalette],
  );

  // Global keydown listener: ⌘K opens palette, `?` opens help dialog,
  // `g X` performs leader-key navigation. All three respect the
  // editable-field carve-out so typing inside <input> doesn't trigger.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const eventLike = {
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        target:
          e.target instanceof Element
            ? {
                tagName: e.target.tagName,
                isContentEditable:
                  e.target instanceof HTMLElement
                    ? e.target.isContentEditable
                    : false,
              }
            : null,
      };

      // Esc closes the palette when open. cmdk also handles Esc but we
      // close at the wrapper layer so focus restoration runs.
      if (open && e.key === "Escape") {
        e.preventDefault();
        closePalette();
        return;
      }

      if (isPaletteHotkey(eventLike)) {
        e.preventDefault();
        openPalette();
        return;
      }

      // Help + leader keys are disabled while the palette is open
      // (cmdk owns the input field's keyboard while open).
      if (open) return;

      if (isHelpHotkey(eventLike)) {
        e.preventDefault();
        if (typeof document !== "undefined") {
          restoreFocusRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }
        setOpen(true);
        setView("help");
        setQuery("");
        return;
      }

      // Leader-key state machine (`g` then second key).
      if (isLeaderKey(eventLike)) {
        leaderRef.current = { at: Date.now() };
        return;
      }

      const leader = leaderRef.current;
      if (
        leader &&
        Date.now() - leader.at < LEADER_TIMEOUT_MS &&
        !isFromEditableField(eventLike.target)
      ) {
        const href = resolveLeaderShortcut(e.key);
        leaderRef.current = null;
        if (href) {
          e.preventDefault();
          router.push(href);
        }
      }
    }

    function onOpenEvent() {
      openPalette();
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
    };
  }, [open, openPalette, closePalette, router]);

  const filtered = useMemo(
    () => filterActionsForRole(STATIC_ACTIONS, role),
    [role],
  );
  const groups = useMemo(() => groupActionsByCategory(filtered), [filtered]);

  if (!open) {
    // Don't mount the cmdk dialog DOM when closed — keeps the palette
    // out of the DOM for a11y tools (no hidden landmarks) and avoids
    // accidental shortcut conflicts.
    return null;
  }

  if (view === "help") {
    // Help view doesn't need cmdk's filter machinery — render the
    // static markup directly so screen readers see the same shape as
    // the static-test path.
    return (
      <CommandPaletteView
        open={open}
        view="help"
        role={role}
        query=""
        onClose={closePalette}
        onShowActions={() => setView("actions")}
      />
    );
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closePalette();
      }}
      label="Command palette"
      className="fixed inset-0 z-50"
      contentClassName="fixed left-1/2 top-24 z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-xl"
      overlayClassName="fixed inset-0 z-40 bg-black/60"
    >
      <header className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          Command palette
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setView("help")}
            className="rounded-md border border-[hsl(var(--border))] px-2 py-0.5 text-[10px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--card))]"
            aria-label="Show keyboard shortcuts"
          >
            ?
          </button>
          <button
            type="button"
            onClick={closePalette}
            className="rounded-md border border-[hsl(var(--border))] px-2 py-0.5 text-[10px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--card))]"
            aria-label="Close command palette"
          >
            Esc
          </button>
        </div>
      </header>

      <div className="border-b border-[hsl(var(--border))] px-4 py-2">
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Type a command or search…"
          aria-label="Search commands"
          className="w-full bg-transparent text-sm outline-none placeholder:text-[hsl(var(--muted-foreground))]"
        />
      </div>

      <Command.List className="max-h-96 overflow-y-auto py-1">
        <Command.Empty className="px-4 py-6 text-center text-xs text-[hsl(var(--muted-foreground))]">
          No commands match.
        </Command.Empty>
        {groups.map((group) => (
          <Command.Group
            key={group.category}
            heading={group.label}
            className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[hsl(var(--muted-foreground))]"
          >
            {group.actions.map((action) => (
              <Command.Item
                key={action.id}
                value={`${action.id} ${action.label} ${action.hint ?? ""}`}
                onSelect={() => dispatchAction(action)}
                className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-2 text-left text-sm aria-selected:bg-[hsl(var(--card))] data-[selected=true]:bg-[hsl(var(--card))]"
              >
                <span className="flex flex-col">
                  <span>{action.label}</span>
                  {action.hint ? (
                    <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                      {action.hint}
                    </span>
                  ) : null}
                </span>
                {action.shortcut ? (
                  <span className="flex items-center gap-1">
                    {action.shortcut.map((k, i) => (
                      <kbd
                        key={`${action.id}-kbd-${i}`}
                        className="rounded border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))]"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                ) : null}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
