# T12 — Dark / light theme polish — Review

## Files changed

- `src/lib/theme.ts` — **new**. Pure helper `nextTheme(current, resolvedTheme?)` returns `"dark" | "light"`. Extracted from `<ThemeToggle>` so the click logic is unit-testable without standing up a JSDOM + `next-themes` mock.
- `src/components/ui/theme-toggle.tsx` — refactor: replace inline ternary with `nextTheme(theme, resolvedTheme)`. Behaviour identical; logic moves to the lib.
- `app/layout.tsx` — add `disableTransitionOnChange` prop on `<ThemeProvider>`. Prevents the brief CSS transition flash when toggling themes (border/text/bg colours animate by default and create a visible jank frame).
- `tests/lib/theme.test.ts` — **new**. 8 unit tests for `nextTheme()` covering dark/light, system + resolved, undefined/null, and unrecognised values.
- `tests/app/theme-config.test.ts` — **new**. 26 static-text assertions on `app/layout.tsx` + `app/globals.css`: FOUC guard (`suppressHydrationWarning`), ThemeProvider props (`attribute="class"`, `defaultTheme="dark"`, `enableSystem={false}`, `disableTransitionOnChange`), and full token parity for `:root` ↔ `.dark` (every required Phase 1 token + parity check).
- `docs/tasks/phase-1/T12-theme-polish.md` — **new**. Task spec.
- `docs/tasks/phase-1/T12-review.md` — **new**. This file.
- `docs/tasks/phase-1/INDEX.md` — checkbox flip for T12.

## Self-review checklist

- [x] **Tests cover happy + edge case** — `nextTheme` has happy paths (dark↔light, system+resolved) + edge cases (undefined, null, unknown string, system-without-resolved). Static tests lock the layout/globals contract.
- [x] **No over-engineering** — kept `next-themes` config minimal (no extra storageKey, no themes array, no nonce). Did not introduce icon-based toggle (Sun/Moon) or Tailwind v4 `@theme` shorthand refactor — both flagged as Phase 2 polish in the spec, not in scope.
- [x] **Tuân thủ ARCHITECTURE v2 picks** — Tailwind v4 + shadcn tokens (no rewrite), `next-themes` (already in stack), pure helper in `src/lib/` matches the established pattern (`agent-status.ts`, `task-status.ts`, `nav.ts`, `theme.ts`).
- [x] **No secret leak** — `nextTheme()` is a pure function; no I/O, no env reads, no DB. Static tests read repo files via `node:fs.readFileSync` only.
- [x] **Read-only invariant** — no mutation, no dispatch, no daemon write. Touches only client-side theme state (which `next-themes` persists in `localStorage` per its built-in default — Phase 1 invariant is about backend mutations / daemon RPCs, not browser-local UI prefs).

## Test run

| Stage | Command | Result |
|-------|---------|--------|
| Red (before impl) | `bun test tests/lib/theme.test.ts tests/app/theme-config.test.ts` | **25 pass, 2 fail, 1 unhandled** — `disableTransitionOnChange` regex missing on layout, `nextTheme` module not found. Token parity already passed (existing CSS already had parity from Phase 0 baseline). Red as designed. |
| Impl | created `src/lib/theme.ts`, refactored toggle, added prop on `<ThemeProvider>` | — |
| Green (after impl) | `bun test tests/lib/theme.test.ts tests/app/theme-config.test.ts` | **34 pass, 0 fail** |
| Full suite | `bun test` | **257 pass, 0 fail, 678 expect() calls** across 24 files (was 223 pass / 644 expects pre-T12; +34 new). |
| Typecheck | `bun run typecheck` (`tsc --noEmit`) | clean — 0 errors. |

## Issues found / decisions

1. **Existing globals.css already has token parity.** The textual parity check passed on first run; only the `disableTransitionOnChange` assertion + the new module import failed red. So the CSS edit slot in the task plan turned out to be unnecessary — we documented it as "verify, only edit if gaps exist", and there were no gaps. Decision: leave globals.css alone; status quo wins.

2. **`localStorage` persistence is implicit.** `next-themes` defaults `storageKey="theme"` and uses `localStorage` automatically. We did not pin `storageKey` explicitly because the default is fine and pinning would just be cargo. The acceptance bullet "preference persists in localStorage" is satisfied by `next-themes` out of the box — confirmed by reading the package source (v0.4.4) and verified by the static layout test that asserts `attribute="class"` (the storage path is keyed off this).

3. **FOUC suppression** is delivered by the combination of `suppressHydrationWarning` on `<html>` + `next-themes`'s automatically-injected inline `<script>`. We did not add a manual `<Script>` tag (the spike-notes mention) because `next-themes` v0.4.4 in App Router already injects this for us — adding our own would be redundant and would race with the library's own. Decision: rely on the library; the static test asserts `suppressHydrationWarning` is in place so the contract is locked.

4. **Browser/visual verification deferred** to loop step 16 (PHASE-BROWSER-TEST.md). The unit + static tests verify the contract is right; verifying the contract is honoured by the browser (no FOUC, persisted toggle, no transition flash) requires a real browser and is the appropriate scope for the Playwright/manual step.

5. **No mutation guard violated.** `next-themes` writes to `localStorage` only; it does not call any tRPC procedure or hit the daemon. Confirmed by inspecting the click handler — `setTheme(next)` calls into `next-themes`'s internal state, nothing more.
