# T07 — Mobile responsive pass + Lighthouse ≥ 90

> **Status:** ✅ Done — committed on `main`.
> **Phase 4 invariant satisfied:** every primary route renders at
> 390×844 (iPhone 14) without horizontal scroll, every interactive
> element below `md` carries a 44×44 touch target, and Lighthouse mobile
> reports perf / a11y / best-practices ≥ 90 across all 8 audited routes.
>
> **Source plan:** v1 IMPLEMENTATION-PLAN.md §Phase 4 P4-T7.

---

## Goal

Lift the Phase 1–3 dashboard from "desktop-first laptop UI" to a usable
phone surface so on-call team members can triage tasks / loops while
away from a workstation. Two independent acceptance gates:

1. **Layout** — sidebar collapses into a drawer below `md`; topbar
   stays sticky; tables remain reachable (horizontal scroll inside the
   table container is OK; the *page* itself never scrolls horizontally).
2. **Lighthouse mobile ≥ 90** — measured on a Slow-4G + 4× CPU throttled
   `next start` run against the Playwright fixture DB. Report JSON
   committed under `docs/tasks/phase-4/lighthouse/`.

Touch-target rule (Apple HIG / WCAG 2.5.5 AAA): every clickable element
inside the mobile viewport has a hit area ≥ 44×44 px.

---

## What landed

### 1. Mobile-nav infrastructure

| File                                     | Role                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/lib/mobile-nav.ts`                  | Pure helpers: `isMobileViewport`, `shouldCloseOnPathChange`, `meetsTouchTarget`, constants.   |
| `src/components/ui/sheet.tsx`            | Headless drawer — backdrop, focus trap, ESC, body-scroll lock, focus restore on close.         |
| `src/components/mobile-nav.tsx`          | Hamburger trigger + `<Sheet>` + nav-link list. Auto-closes drawer on route change.             |

The hamburger button is `h-11 w-11` (44 × 44) with `md:hidden` — the
desktop sidebar takes over from `md` (768 px) up.

### 2. Sidebar / Topbar adjustments

| File                              | Change                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/components/sidebar.tsx`      | Added `hidden md:flex` so the desktop sidebar disappears on mobile (the drawer takes over).    |
|                                   | Bumped each `<Link>` to `h-11` (mobile) compressing back to `md:h-9` for compact desktop nav.  |
| `src/components/topbar.tsx`       | `sticky top-0 z-30` + translucent backdrop blur. Mounts `<MobileNav>` (hidden on `md+`).        |
| `src/components/dispatch-trigger.tsx` | `h-11 sm:h-9` — mobile bumps to 44 px so the topbar stays one-tap.                          |
| `src/components/command-palette-trigger.tsx` | `h-11 sm:h-9 w-full sm:w-auto` — fills the topbar centre on mobile, hides ⌘K kbd glyph below `sm`. |
| `src/components/ui/theme-toggle.tsx` | `h-11 sm:h-9 min-w-[44px]` — same rule.                                                      |
| `app/layout.tsx`                  | `<main>` padding: `p-4 sm:p-6` so the page gets every pixel on small viewports.                |

### 3. Tables

The Phase 1–3 tables (Tasks / Loops / Schedules / Audit / Cost-by-user
/ Users) already wrap in `<div class="overflow-x-auto">` — horizontal
scroll happens *inside the table container*, never on the document
itself. Lighthouse audited every route under 390 × 844 with no
`uses-document-overflow` or `tap-targets` violation triggered, so we
intentionally did NOT rebuild the tables as cards. Doing so would have
forced a `<dl>` rewrite of six surfaces and roughly tripled the diff
without a measurable usability win for our 5–10-person team scale
(filed as Phase 5 polish if the team grows past 50).

### 4. Lighthouse runner + acceptance gate

| File                                          | Role                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/lighthouse-mobile.ts`                | Builds → starts the dashboard → logs in with the fixture password → runs Lighthouse mobile against 8 routes → emits per-route JSON + `summary.json`. |
| `package.json` script `lighthouse:mobile`     | One-shot entry point.                                                                                                                 |
| `docs/tasks/phase-4/lighthouse/*.report.json` | Full Lighthouse reports per route (8 files, ~500 kB each).                                                                            |
| `docs/tasks/phase-4/lighthouse/summary.json`  | Per-route category scores + `passedAll` boolean. Read by the test gate below.                                                          |
| `tests/app/lighthouse-summary.test.ts`        | Bun-test gate that fails CI if any route in `summary.json` drops below 90 on perf / a11y / best-practices.                            |

#### Last-known scores (mobile, Slow 4G, 4× CPU throttle, `next start`)

| Route              | Perf | A11y | BP   | SEO  |
| ------------------ | ---: | ---: | ---: | ---: |
| `/`                |   96 |   98 |   96 |   91 |
| `/agents`          |   99 |   98 |   96 |   91 |
| `/tasks`           |   99 |  100 |   96 |   91 |
| `/loops`           |   98 |  100 |   96 |   91 |
| `/schedules`       |   98 |  100 |   96 |   91 |
| `/cost`            |   99 |   99 |   96 |   91 |
| `/audit`           |   98 |  100 |   96 |   91 |
| `/settings/users`  |   98 |  100 |   96 |   91 |

All eight routes pass the ≥ 90 gate on perf / a11y / best-practices.
SEO holds at 91 (single-`<meta>` heuristic; Lighthouse marks the
authenticated routes "needs canonical link" — we deliberately omit
canonical tags on auth-gated surfaces).

### 5. Tests

| Spec                                        | Coverage                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `tests/lib/mobile-nav.test.ts`              | 12 cases — viewport breakpoint, path-change auto-close, touch-target utility math.  |
| `tests/app/sheet.test.tsx`                  | 7 cases — closed renders nothing, dialog roles, side anchoring, close-button 44×44, backdrop, child forwarding. |
| `tests/app/responsive-shell.test.tsx`       | 6 cases — Sidebar `hidden md:flex`, link `h-11`, Topbar `sticky top-0 z-30`, hamburger `md:hidden + h-11 w-11`, user-menu `hidden sm:block`. |
| `tests/app/lighthouse-summary.test.ts`      | 4 cases — summary file exists, all 8 routes audited, every score ≥ 90, valid timestamp. |

Total new coverage: **29 cases** across 4 files.

---

## How to re-run

```bash
# 1. Refresh fixtures + run Lighthouse mobile
bun run lighthouse:mobile

# 2. (Already gated by) the unit-test sweep
bun test
```

The script is idempotent — it builds, starts the dashboard on `:3110`,
audits, kills the dashboard. Output lands under
`docs/tasks/phase-4/lighthouse/` (per-route JSONs + summary).

---

## Decisions deliberately deferred

- **Card-style table layout on mobile**: the existing
  `overflow-x-auto` wrappers ship the full table without breaking
  page scroll. Re-rendering rows as `<dl>` cards is filed as Phase 5
  polish — the v1 plan does not require it and the team scale (5–10)
  doesn't justify the diff today.
- **Per-row swipe actions** (kill / cancel / pause): same — Phase 5.
- **A11y AA contrast pass + dark/light token regen**: explicitly
  T10 ("theme polish + AA contrast"), not T07.
- **Service worker / PWA install**: out of scope for GA `v0.1.0`.

---

## Cross-references

- Acceptance: every Phase 4 task INDEX section §6 ("Mobile-first") —
  satisfied by the Lighthouse gate + responsive-shell tests.
- Phase 5 follow-ups: card-style tables, swipe actions, PWA install.
