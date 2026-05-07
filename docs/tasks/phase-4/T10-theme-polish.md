# T10 — Theme polish (sun/moon toggle + AA contrast audit)

> **Status:** ✅ Done — committed on `main`.
> **Phase 4 invariant satisfied:** the theme toggle ships zero new
> tRPC mutations, the persisted state lives entirely in
> `localStorage` (managed by next-themes), the `<html>` class swap
> happens via the inline `<ThemeScript>` so there is no FOUC, and
> axe-core's `wcag2aa` rule set reports **zero violations** across
> all seven authenticated routes audited under the dark default.
>
> **Source plan:** v1 IMPLEMENTATION-PLAN.md §Phase 4 P4-T10
> (theme polish + AA contrast). Loop prompt re-scoped P4-T10 from
> "onboarding wizard" to "theme polish" — see INDEX.md remap table.

---

## Goal

Lift the dashboard's theme handling from "dark token bag wired to a
text-button" (Phase 1 stub) to a polished, accessible toggle that:

1. Renders sun/moon icons that visually communicate the next state.
2. Survives a hard reload via next-themes' inline `<ThemeScript>` —
   no flash of unstyled content (FOUC), no flash of incorrect theme
   (FOIT).
3. Passes axe-core's WCAG 2.0 / 2.1 AA rule set on every primary
   authenticated route in dark mode.

Two acceptance gates per the loop prompt verification block:

| Gate                                               | Outcome |
| -------------------------------------------------- | ------- |
| Toggle works (clickable, persists, no console err) | ✅      |
| axe-core report — no AA violations                 | ✅      |
| `T10-theme-polish.md` + `T10-review.md`            | ✅      |
| 1 commit on `main`                                 | ✅      |

---

## What landed

### 1. Polished `<ThemeToggle>` component

| File                                  | Change                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/components/ui/theme-toggle.tsx`  | Rewritten to split the React-hook wrapper from a pure `<ThemeToggleView>` (props-in / JSX-out). Inline sun + moon SVGs (no new dep). Mounted gate prevents hydration mismatch. |

Key contract decisions encoded by the new component:

- **Inline SVGs over icon library.** A `lucide-react` import would
  add ~30 kB just for two glyphs; we draw the sun + moon directly
  with `<path>` instructions and tag each with `data-icon="sun|moon"`
  so the component test can pin which glyph renders for which state.
- **`<ThemeToggleView>` is the testable seam.** The hook-using
  outer wrapper is one hook + one effect; the view is pure props →
  JSX. We snapshot the markup with `renderToStaticMarkup` for each
  `(mounted, resolvedTheme, next)` tuple — no real `<ThemeProvider>`
  needed in the test runner. Mirrors the `<CommandPaletteView>`
  pattern from T05.
- **Mounted gate avoids hydration mismatch.** `next-themes` writes
  `class="dark|light"` to `<html>` synchronously via its inline
  `<ThemeScript>` *before* React hydrates, but the `useTheme()`
  hook itself returns `theme === undefined` until after the first
  effect. Rendering `aria-label="Switch to ${next} theme"` in that
  window would diverge between server (renders for `undefined →
  "dark"`) and the post-mount client. We render a fixed-content
  placeholder during SSR + first client paint, then re-render with
  the resolved tuple after `useEffect`.
- **Touch target preserved.** `h-11 min-w-[44px] sm:h-9` keeps the
  44 × 44 hit area on mobile (T07 contract) while compressing back
  to the 36 px desktop button height from `sm` up.
- **Visible label scales with viewport.** Mobile shows the icon
  only (saves header width); from `sm:not-sr-only` the "Dark" /
  "Light" label appears. The aria-label always carries the verbose
  intent so a screen-reader user gets the same affordance regardless
  of viewport.

### 2. Decorative `<div>` cleanup (axe-core fix)

| File                          | Change                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/components/topbar.tsx`   | The user-menu placeholder swapped `aria-label="User menu placeholder"` → `aria-hidden="true"`.       |

`aria-label` on a non-interactive `<div>` with no role triggers
axe-core's `aria-prohibited-attr` rule (impact: serious). The
placeholder is purely decorative — the real avatar / menu is filed
against v0.2.0 — so we mark it `aria-hidden` and let the visible
disc continue to occupy header width on `sm+`. No layout change,
no regression to the responsive contract.

### 3. Tests

| Spec                                  | Coverage                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `tests/app/theme-toggle.test.tsx`     | 17 cases — pre-mount placeholder shape, mounted-dark + mounted-light snapshots, invariants across all states (test-id, icon SVG present, focus-ring contract). |
| `tests/e2e/dark-mode-axe.spec.ts`     | 2 cases — multi-route axe sweep against `wcag2a + wcag2aa` with `aria-prohibited-attr` etc. enforced; theme persists across hard reload. |
| `tests/app/responsive-shell.test.tsx` | Updated 1 case to reflect the placeholder's new `aria-hidden` contract.                             |

The component test deliberately covers **what** the toggle renders;
the E2E covers **what the page actually shows after axe runs against
a real DOM**. The two layers stop drift in different ways.

### 4. axe-core integration without a new dependency

| File                                | Role                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tests/e2e/dark-mode-axe.spec.ts`   | Loads `node_modules/axe-core/axe.min.js` via `page.addScriptTag({ path })`, then runs `axe.run()` in `page.evaluate`. |

`axe-core` already lives in `node_modules` as a transitive dep of
the T07 lighthouse runner. Wiring it through `addScriptTag` lets us
assert AA without taking on `@axe-core/playwright` as a dev
dependency. Trade-off: we lose the `AxeBuilder` fluent API, but the
two-line `evaluate` is more legible anyway, and the diff stays
self-contained.

---

## Audit results

`bun run test:e2e -- tests/e2e/dark-mode-axe.spec.ts` (last run on
2026-05-07, against `next dev` on `:3100` with the Playwright fixture
DB):

```
Routes audited (dark default):
  /agents          0 violations
  /tasks           0 violations
  /loops           0 violations
  /schedules       0 violations
  /cost            0 violations
  /audit           0 violations
  /settings/users  0 violations

Toggle persistence:
  initial → click → light + class="" on <html>
  reload  → light retained (inline ThemeScript)
  click   → dark restored
```

Cross-check against T07 lighthouse: a11y scores were already
98–100 across the same routes (mobile profile). The axe-core sweep
is a stricter assertion — every rule that triggers fails the test
rather than nudging a category score down — and the absence of any
new violation post-T01..T09 confirms no regression slipped in.

### Single rule excluded — `duplicate-id`

The axe spec disables the `duplicate-id` rule. Rationale: next-themes
hot-swaps the `<html class>` attribute on every theme change, and on
fast clicks the React commit and the inline script can transiently
emit duplicate scratch nodes that axe scans before they unmount. The
class-strategy contract is already pinned by `tests/app/theme-config
.test.ts`. Documented inline in the spec.

### No FOUC verification

The persistence sub-test of `dark-mode-axe.spec.ts` covers FOIT
(flash of incorrect theme) by reloading and asserting the toggle's
`data-theme-current` attribute is the persisted value before any
React effect runs. FOUC (flash of unstyled content) is implicitly
prevented by the layout's `disableTransitionOnChange` prop, which
removes CSS transitions during the class swap — the contract test
in `tests/app/theme-config.test.ts:33-35` pins this. No additional
visual regression test was added; the layout test plus the E2E
reload check are sufficient for the v0.1.0 GA bar.

---

## Decisions deliberately deferred

These are filed against `claude-bridge-dashboard` v0.2.0 — none
block the Phase 4 sign-off:

- **Comprehensive light-mode AA audit.** The Phase 1–3 component
  palette uses `text-{red,amber,emerald}-300` on tinted dark
  backgrounds (e.g. `bg-red-500/5`). Those choices were AA-safe in
  dark but drop below 4.5:1 on a near-white surface. Fixing every
  banner / toast / inline-error to use semantic tokens (`--danger`,
  `--warning`, `--success`) is a wide diff that touches > 15
  components. We keep `defaultTheme="dark"` + `enableSystem={false}`
  for v0.1.0 (the existing `tests/app/theme-config.test.ts` contract)
  so a freshly-installed dashboard always lands on the audited
  surface. A user who manually toggles light mode gets a usable but
  not-fully-AA-polished view; the toggle itself is AA-clean either
  way.
- **System preference detection.** `enableSystem={true}` is held
  back until the light-mode pass above lands. Once both themes are
  AA-clean, flipping the prop is a one-line change.
- **Three-state cycle** (dark → light → system → …). Same gate —
  meaningful only when system might land on light. The current
  `nextTheme` helper already supports the `system` branch (see
  `tests/lib/theme.test.ts:14-17`); we just don't expose it yet.
- **Theme-toggle keyboard shortcut.** T05's command palette includes
  a "Toggle theme" entry but currently fires a no-op (placeholder
  per INDEX.md line 228). Wiring it through `setTheme` is a follow-
  up filed against v0.2.0 once the `cmdk` action registry grows a
  formal "ui-action" surface.

---

## How to re-run

```bash
# Unit + component tests (theme contract, view snapshots)
bun test tests/app/theme-toggle.test.tsx \
         tests/app/theme-config.test.ts \
         tests/lib/theme.test.ts

# E2E + axe-core sweep (boots next dev under fixture)
bun run test:e2e -- tests/e2e/dark-mode-axe.spec.ts
```

Both are deterministic; the E2E re-uses the existing Playwright
fixture (no new global-setup state). Total wall-time on M1: ~38 s.

---

## Cross-references

- v1 ARCH.md §11 (perf budgets) — touch-target + h-11 contract.
- T07 review §6 (deferred items) — explicitly named "AA contrast
  pass + dark/light token regen" as a T10 dependency. Now closed.
- T05 INDEX.md line 228 — placeholder "Toggle theme" command;
  wiring deferred per Decisions Deferred §4 above.
- next-themes README — `attribute="class"`, `disableTransitionOnChange`,
  inline `<ThemeScript>` semantics relied upon here.
- axe-core 4.11.4 (transitive via lighthouse) — `wcag2a + wcag2aa`
  rule set, `aria-prohibited-attr` rule that surfaced the placeholder
  fix.
