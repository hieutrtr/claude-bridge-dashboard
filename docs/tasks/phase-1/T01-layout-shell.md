# P1-T01 — Layout & navigation shell

> Phase 1, Task 1 of 13. Read-only invariant — this task wires UI chrome only;
> no data mutation, no API mutation procedure.

## Source

- v1 plan task: `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/IMPLEMENTATION-PLAN.md` line 63 ("P1-T1 — Layout & navigation shell").
- v2 plan: re-points to v1 P1-T1 (no override).

## Architecture refs to read first

- `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/ARCHITECTURE.md`
  - §1 (Design Principles) — self-hosted, type-safe, zero-port-by-default.
  - §2 (Tech Stack Final Picks) — Next.js 15 App Router + shadcn/ui + Tailwind v4.
  - §11 (Performance Budgets) — first-load JS < 200 KB; the shell must stay lean.

## Spec (paraphrased from plan)

> Sidebar (Agents, Tasks, Loops, Schedules, Cost) + topbar (search, user menu).
> Tailwind + shadcn `Sidebar` component.
> Acceptance: 5 route stubs render; active state changes color.

## Acceptance criteria

1. `/agents`, `/tasks`, `/loops`, `/schedules`, `/cost` each render a stub page
   with a heading. No 404.
2. A persistent left-side `<Sidebar>` shows exactly five nav links, in order:
   Agents, Tasks, Loops, Schedules, Cost. Each link points to the matching
   route.
3. The link matching the current `pathname` (or any sub-path of it, e.g.
   `/agents/foo`) is rendered with an "active" visual state distinct from the
   inactive links (different background or text color).
4. A top-level `<Topbar>` is present at the top of every authenticated page
   with the product name and a slot for the existing `<ThemeToggle>`.
   (Search input + user menu are stubs only — Phase 1 invariant: no logic.)
5. The shell is **read-only**: no buttons or forms in T01 trigger any mutation
   procedure. Topbar's search input is a placeholder `<Input>` — no submit
   handler.

## Test plan (TDD — Bun test)

The shell components themselves are pure presentation; they read from a small
nav module. We unit-test that module + a "route stub exists" smoke check.
Full DOM-interaction coverage is deferred to T13 (Playwright E2E).

### `tests/lib/nav.test.ts` (NEW)

- `NAV_ITEMS` exports exactly 5 items with `{ label, href }` in order:
  Agents → /agents, Tasks → /tasks, Loops → /loops, Schedules → /schedules,
  Cost → /cost.
- `isNavActive(pathname, href)`:
  - returns `true` for exact match (`/agents` matches `/agents`).
  - returns `true` for sub-path match (`/agents/foo` matches `/agents`).
  - returns `false` for unrelated paths (`/tasks` does NOT match `/agents`).
  - returns `false` for prefix-only-match-on-name (`/agents-foo` does NOT match `/agents`).
  - returns `true` for `/` matching `/` exactly, `false` for `/` matching `/agents`.

### `tests/app/route-stubs.test.ts` (NEW)

- For each of the 5 routes (`agents`, `tasks`, `loops`, `schedules`, `cost`),
  importing `app/<route>/page.tsx` resolves to a default export that is a
  function (server or client component). Smoke check that the file exists +
  has a default export — no rendering required.

## Files to create / modify

- NEW `src/lib/nav.ts` — `NAV_ITEMS` const + `isNavActive` pure helper.
- NEW `src/components/sidebar.tsx` — Client Component (`"use client"`) using
  `usePathname()` from `next/navigation`, mapping over `NAV_ITEMS`.
- NEW `src/components/topbar.tsx` — Server Component shell with brand + slot.
- NEW `app/tasks/page.tsx`, `app/loops/page.tsx`, `app/schedules/page.tsx`,
  `app/cost/page.tsx` — stub pages, each with `<h1>` only.
- MODIFIED `app/layout.tsx` — wrap `{children}` in `<div class="flex">`
  with `<Sidebar />` + a flex column containing `<Topbar />` + `<main>`.
- MODIFIED `app/page.tsx` — redirect `/` to `/agents` (using `next/navigation`
  `redirect()`), so the home route is a useful landing.
- NEW `tests/lib/nav.test.ts`, `tests/app/route-stubs.test.ts`.

## Notes / open questions

- shadcn ships a heavyweight `Sidebar` block (with collapsible state, sheet,
  etc.). Phase 1 invariant says "no logic" and Performance Budget §11 caps
  first-load JS at 200 KB. So we render a flat custom `<aside>` with Tailwind
  utility classes — visual parity, zero state. If a richer sidebar is needed
  later (mobile sheet, collapse), that's a Phase 2+ concern.
- We deliberately do NOT add Testing Library / happy-dom in this task. Adding
  a DOM stack just to assert active-state classes when T13 (Playwright)
  already covers it would violate "minimal changes". The active-state logic
  is extracted to a pure helper that we *can* unit-test cheaply.
- The top-bar "search" + "user menu" mentioned in the plan are visual stubs
  only (no logic). Real search lands in Phase 2; user menu lands in T02
  (auth) where logout becomes meaningful.
- Active state styling: use `bg-[hsl(var(--card))]` on active link,
  `text-[hsl(var(--foreground))]/60` on inactive. Tokens already in
  `globals.css` from Phase 0.
