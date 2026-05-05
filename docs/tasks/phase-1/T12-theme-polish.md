# T12 — Dark / light theme polish

> **Phase 1 invariant: READ-ONLY.** This task is UI/style polish only —
> it must not touch tRPC procedures, the daemon, or any persisted
> mutation surface.

## Plan reference

- v1 plan task: `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/IMPLEMENTATION-PLAN.md` lines around `**P1-T12 — Dark / light theme**`.
- v1 architecture: `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/ARCHITECTURE.md` §2 (Tailwind v4 + shadcn dark tokens).
- Spike notes (FOUC follow-up): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/spike-notes.md` lines 113–116 — Phase 0 deferred the FOUC suppression `<script>` snippet to this task.
- Phase 0 baseline: `tasks/phase-0/T07-tailwind-shadcn.md` (the `next-themes` ThemeProvider + `<ThemeToggle>` already exist; do not re-do).

## Acceptance criteria

Copy / paraphrase from v1 plan §P1-T12 + spike-notes follow-up:

1. Theme toggle is mounted in the topbar (already present from T01/Phase 0). Clicking flips between `dark` ↔ `light`.
2. Preference persists in `localStorage` across reloads. (Default behaviour of `next-themes`; verified explicitly here.)
3. SSR renders without FOUC: `<html>` carries the resolved theme class **before first paint** — `next-themes` injects an inline `<script>` automatically when configured with `attribute="class"` + `suppressHydrationWarning`.
4. Default theme is `"dark"` (per ARCH §1 #3 dark-first principle); first-time visitors see dark.
5. No CSS transition flash when toggling themes (`disableTransitionOnChange`).
6. `globals.css` defines a complete, parity-matched token set for `:root` (light) and `.dark` — every CSS custom property used by Phase 1 components has both modes.

## Test plan (TDD, write before code)

### Unit — `src/lib/theme.ts` (new pure helper)

`tests/lib/theme.test.ts`:

- `nextTheme("dark")` → `"light"`
- `nextTheme("light")` → `"dark"`
- `nextTheme("system")` with `resolvedTheme = "dark"` → `"light"`
- `nextTheme("system")` with `resolvedTheme = "light"` → `"dark"`
- `nextTheme(undefined)` → `"dark"` (sensible default while next-themes is hydrating)
- `nextTheme(null)` → `"dark"`
- Unknown string → `"dark"` (defensive)

The helper is the testable kernel of `<ThemeToggle>`'s click handler.

### Static — `tests/app/theme-config.test.ts` (new)

Reads `app/layout.tsx` + `app/globals.css` as text and asserts:

- `<html ... suppressHydrationWarning>` is present (without it `next-themes` warns + may delay paint).
- `<ThemeProvider>` props include `attribute="class"`, `defaultTheme="dark"`, `enableSystem={false}`, `disableTransitionOnChange`.
- `globals.css` contains a `:root {` block and a `.dark {` block.
- Every token defined in `:root` has a counterpart in `.dark` (parity).
- Both blocks define the canonical Phase 1 tokens: `--background`, `--foreground`, `--card`, `--card-foreground`, `--primary`, `--primary-foreground`, `--border`, `--input`, `--ring`.

These tests are intentionally textual: the goal is to lock the contract so future edits can't accidentally remove the FOUC guard or break parity.

## Files (expected)

- `src/lib/theme.ts` — new, exports `nextTheme()` + `Theme` type.
- `src/components/ui/theme-toggle.tsx` — refactored to call `nextTheme()`.
- `app/layout.tsx` — add `disableTransitionOnChange` prop on `<ThemeProvider>`.
- `app/globals.css` — verify / fill any missing parity tokens (check current state first; only edit if gaps exist).
- `tests/lib/theme.test.ts` — unit (red → green).
- `tests/app/theme-config.test.ts` — static (red → green).
- `docs/tasks/phase-1/T12-review.md` — self-review at the end.

## Open questions / out-of-scope

- **System theme support** is intentionally **off** (`enableSystem={false}`) — v1 ARCH §1 #3 says dark-first; system-following is a Phase 4 polish item.
- **Icon-based toggle** (Sun / Moon) is left as Phase 2 polish; current text label ("Dark" / "Light") is sufficient and avoids pulling in `lucide-react` for one icon. Status quo.
- **Tailwind v4 `@theme` block** for `bg-primary` / `text-foreground` shorthands is also Phase 2 polish — Phase 1 components use the explicit `bg-[hsl(var(--primary))]` form which works today. Refactor would balloon the diff.
- **Per-component visual QA** of every Phase 1 surface in light mode is part of the browser test (loop step 16), not this task.
