// P4-T05 — pure helpers for the ⌘K command palette. No DOM, no React,
// no `cmdk` import here. The component (`src/components/command-palette.tsx`)
// owns the cmdk wrapper + DOM listeners; this module owns the action
// registry, role filtering, label-escape contract, and global-hotkey
// detection. Bun unit tests exercise this surface end-to-end.
//
// Three contracts the palette UI relies on, defined here so they
// cannot drift across files:
//
//   1. **Action shape.** Every action is a plain JSON object with a
//      `label: string` (no embedded HTML — the renderer always uses
//      `{action.label}` JSX, never `dangerouslySetInnerHTML`). Action
//      labels are NEVER user-supplied for the static set; the dynamic
//      "Jump to agent {name}" actions take `name` straight from the
//      daemon's `agents.list` payload, which is already validated by
//      the agents tRPC zod schema. We belt-and-suspenders the XSS
//      contract with `assertSafeLabel()` below — used in the palette
//      tests to guard the dynamic merge step.
//
//   2. **Role filtering.** Owner-only commands carry `ownerOnly: true`.
//      The palette resolves the caller's role from `auth.me` once on
//      mount and re-filters on every render; null role (signed-out or
//      session resolution failure) hides every owner-only command.
//
//   3. **Hotkey detection.** Two detectors are exposed:
//        - `isPaletteHotkey(e)` — ⌘K / Ctrl+K (no shift, no alt).
//        - `isHelpHotkey(e)` — `?` outside an editable field.
//      The "g X" leader-key sequence (g a → /agents, etc.) is
//      modelled by `LEADER_KEY` + `resolveLeaderShortcut(secondKey)`
//      so the component can run a tiny state machine (last-key +
//      timestamp) without re-implementing the routing table here.

export type Role = "owner" | "member";

export type ActionCategory = "action" | "navigate" | "system";

export type ActionIntent =
  | { type: "navigate"; href: string }
  | { type: "open-dispatch" }
  | { type: "open-start-loop" }
  | { type: "open-create-schedule" }
  | { type: "logout" }
  | { type: "toggle-theme" }
  | { type: "switch-language" }
  | { type: "show-help" };

export interface PaletteAction {
  /** Stable id, used as the cmdk `value` so search results survive re-renders. */
  id: string;
  /** Plain string — rendered as text only, never as HTML. */
  label: string;
  /** Optional secondary line under the label. */
  hint?: string;
  /** Discoverable shortcut, displayed as `<kbd>` chips in the palette + help dialog. */
  shortcut?: readonly string[];
  category: ActionCategory;
  /** When true, hidden from members. */
  ownerOnly?: boolean;
  intent: ActionIntent;
}

/**
 * Static action set. Ordered by category for the palette's grouped
 * cmdk view; cmdk's fuzzy filter re-orders results as the user types.
 *
 * Acceptance (T05): "10 shortcuts function" — eight discoverable
 * keyboard shortcuts (⌘K, g a, g t, g l, g s, g c, g u, ?) plus two
 * action-only commands ("Dispatch task" + "Sign out") = ten.
 */
export const STATIC_ACTIONS: readonly PaletteAction[] = [
  {
    id: "dispatch",
    label: "Dispatch task to agent…",
    hint: "Open the dispatch dialog (Phase 2)",
    category: "action",
    intent: { type: "open-dispatch" },
  },
  {
    id: "start-loop",
    label: "Start a loop",
    hint: "Open the loop start dialog (Phase 3)",
    category: "action",
    intent: { type: "open-start-loop" },
  },
  {
    id: "new-schedule",
    label: "New schedule",
    hint: "Open the schedule create dialog (Phase 3)",
    category: "action",
    intent: { type: "open-create-schedule" },
  },
  {
    id: "go-agents",
    label: "Go to agents",
    shortcut: ["g", "a"],
    category: "navigate",
    intent: { type: "navigate", href: "/agents" },
  },
  {
    id: "go-tasks",
    label: "Go to tasks",
    shortcut: ["g", "t"],
    category: "navigate",
    intent: { type: "navigate", href: "/tasks" },
  },
  {
    id: "go-loops",
    label: "Go to loops",
    shortcut: ["g", "l"],
    category: "navigate",
    intent: { type: "navigate", href: "/loops" },
  },
  {
    id: "go-schedules",
    label: "Go to schedules",
    shortcut: ["g", "s"],
    category: "navigate",
    intent: { type: "navigate", href: "/schedules" },
  },
  {
    id: "go-cost",
    label: "Go to cost dashboard",
    shortcut: ["g", "c"],
    category: "navigate",
    intent: { type: "navigate", href: "/cost" },
  },
  {
    id: "go-audit",
    label: "Go to audit log",
    category: "navigate",
    intent: { type: "navigate", href: "/audit" },
  },
  {
    id: "go-users",
    label: "Manage users",
    shortcut: ["g", "u"],
    category: "navigate",
    ownerOnly: true,
    intent: { type: "navigate", href: "/settings/users" },
  },
  {
    id: "toggle-theme",
    label: "Toggle theme",
    hint: "Wired in T10 (theme polish)",
    category: "system",
    intent: { type: "toggle-theme" },
  },
  {
    id: "switch-language",
    label: "Switch language",
    hint: "Wired in T12 (i18n scaffold)",
    category: "system",
    intent: { type: "switch-language" },
  },
  {
    id: "logout",
    label: "Sign out",
    category: "system",
    intent: { type: "logout" },
  },
  {
    id: "help",
    label: "Show keyboard shortcuts",
    shortcut: ["?"],
    category: "system",
    intent: { type: "show-help" },
  },
] as const;

/**
 * "Jump to agent {name}" — built from the cached `agents.list` payload
 * after the palette opens. Pure builder so the merge order + escape
 * contract is unit-testable.
 */
export interface AgentLike {
  name: string;
}

export function buildAgentJumpActions(agents: readonly AgentLike[]): PaletteAction[] {
  // Cap at 50 so a runaway daemon doesn't make the palette unscrollable.
  return agents.slice(0, 50).map((a) => {
    const name = sanitizeAgentName(a.name);
    return {
      id: `jump-agent:${name}`,
      label: `Jump to agent ${name}`,
      category: "navigate",
      intent: { type: "navigate", href: `/agents/${encodeURIComponent(name)}` },
    } satisfies PaletteAction;
  });
}

/**
 * Defensive: agent names ride the wire from the daemon. Strip control
 * characters + clamp length so the rendered label can't become a UI
 * payload (e.g. embedded null + tag injection vector when copied to a
 * dangerouslySetInnerHTML elsewhere — we don't do that, but a future
 * maintainer might).
 */
export function sanitizeAgentName(raw: string): string {
  // U+0000–U+001F (control), U+007F (DEL), U+0080–U+009F (C1 controls).
  // Replace newlines + tabs with a single space so the label stays one line.
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return "(unnamed)";
  if (cleaned.length > 64) return cleaned.slice(0, 61) + "…";
  return cleaned;
}

/**
 * Belt-and-suspenders assertion. Throws if a label looks like raw HTML
 * — used in tests to lock in the "labels are text only" contract.
 */
export function assertSafeLabel(label: string): void {
  if (/[<>]/.test(label)) {
    throw new Error(`PaletteAction.label must be plain text (got: ${JSON.stringify(label)})`);
  }
}

export function filterActionsForRole(
  actions: readonly PaletteAction[],
  role: Role | null,
): PaletteAction[] {
  if (role === "owner") return actions.filter(() => true);
  // member or anonymous: hide owner-only entries
  return actions.filter((a) => a.ownerOnly !== true);
}

export function groupActionsByCategory(actions: readonly PaletteAction[]): {
  category: ActionCategory;
  label: string;
  actions: PaletteAction[];
}[] {
  const order: ActionCategory[] = ["action", "navigate", "system"];
  const labels: Record<ActionCategory, string> = {
    action: "Actions",
    navigate: "Navigate",
    system: "System",
  };
  return order
    .map((category) => ({
      category,
      label: labels[category],
      actions: actions.filter((a) => a.category === category),
    }))
    .filter((group) => group.actions.length > 0);
}

// ----- Hotkey detection ---------------------------------------------------

export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** When the event originates from an editable field, hotkeys must not fire. */
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

export function isPaletteHotkey(e: KeyEventLike): boolean {
  if (e.key !== "k" && e.key !== "K") return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.shiftKey || e.altKey) return false;
  return true;
}

export function isHelpHotkey(e: KeyEventLike): boolean {
  if (e.key !== "?") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return !isFromEditableField(e.target);
}

export const LEADER_KEY = "g";

export function isLeaderKey(e: KeyEventLike): boolean {
  if (e.key !== LEADER_KEY) return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return !isFromEditableField(e.target);
}

const LEADER_TABLE: Record<string, string> = {
  a: "/agents",
  t: "/tasks",
  l: "/loops",
  s: "/schedules",
  c: "/cost",
  u: "/settings/users",
};

export function resolveLeaderShortcut(secondKey: string): string | null {
  return LEADER_TABLE[secondKey.toLowerCase()] ?? null;
}

export function isFromEditableField(
  target: KeyEventLike["target"] | undefined,
): boolean {
  if (!target) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

/**
 * The static help-dialog payload. The component renders these as a
 * grid; tests assert on the exact set so future shortcut additions are
 * always reflected in the help dialog.
 */
export const HELP_SHORTCUTS: readonly { keys: readonly string[]; description: string }[] = [
  { keys: ["⌘", "K"], description: "Open command palette" },
  { keys: ["g", "a"], description: "Go to agents" },
  { keys: ["g", "t"], description: "Go to tasks" },
  { keys: ["g", "l"], description: "Go to loops" },
  { keys: ["g", "s"], description: "Go to schedules" },
  { keys: ["g", "c"], description: "Go to cost dashboard" },
  { keys: ["g", "u"], description: "Manage users (owner only)" },
  { keys: ["?"], description: "Show keyboard shortcuts" },
] as const;
