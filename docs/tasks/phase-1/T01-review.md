# P1-T01 review — Layout & navigation shell

> Self-review checklist for Rule 3 of the loop process.

## Files added

- `src/lib/nav.ts` — `NAV_ITEMS` const + `isNavActive` pure helper.
- `src/components/sidebar.tsx` — Client Component with `usePathname()` + `<Link>`.
- `src/components/topbar.tsx` — Server Component shell, brand + disabled
  search input + theme toggle + user-menu placeholder.
- `app/tasks/page.tsx`, `app/loops/page.tsx`, `app/schedules/page.tsx`,
  `app/cost/page.tsx` — stub pages (heading + "lands in Phase X" hint).
- `tests/lib/nav.test.ts` — 6 tests, 13 expects.
- `tests/app/route-stubs.test.ts` — 10 tests, 10 expects (5 routes × 2).

## Files modified

- `app/layout.tsx` — wrap children in flex shell `<Sidebar>` +
  `<Topbar>` + `<main>`. Removed Phase 0 spike-only metadata description.
- `app/page.tsx` — replace "Hello" stub with `redirect("/agents")` so `/`
  is a useful landing.
- `app/agents/page.tsx` — drop the inner `<main>` + raw `<h1>` (now provided
  by the shell), tidy heading classes to match other route stubs.

## Test results

```
$ bun test
 23 pass
 0 fail
 42 expect() calls
Ran 23 tests across 3 files.

$ bun run typecheck
$ tsc --noEmit         # exit 0
```

7 prior discovery tests + 16 new T01 tests = 23 total.

## Self-review checklist

- [x] **Tests cover happy + edge case** — `isNavActive` covers exact, sub-path,
      trailing slash, prefix-only-by-name (boundary: `/agents-foo` ≠ `/agents`),
      unrelated path, and `/` non-match. `NAV_ITEMS` asserts both order and
      href correctness. Route-stubs test covers existence + default-export
      shape for all 5 routes.
- [x] **Not over-engineered** — flat `<aside>` instead of shadcn's heavyweight
      Sidebar block (deliberate trade-off documented in task file). No state,
      no collapse logic, no mobile sheet. shadcn primitives only (`Button`,
      `Input`, `ThemeToggle`).
- [x] **ARCHITECTURE v2 picks honoured** — Next.js App Router (file-based
      routing), tRPC v11 (existing `agents.list` route still wired via
      `createCaller`), Tailwind v4 (CSS tokens from `globals.css`), shadcn
      primitives + `next-themes` already in place. No new heavy deps.
- [x] **No secret leak** — no env vars, no auth tokens, no DB strings in any
      new file. `Sidebar` and `Topbar` are pure UI; `nav.ts` is a static
      const.
- [x] **Read-only invariant** — no mutation procedure called or imported. The
      `<Topbar>` search input is `disabled` with a placeholder note. The
      "user menu" is a styled `<div>` placeholder (no click handler). No
      `bridge_dispatch`, no tRPC mutation, no form submission anywhere. ✅
- [x] **Performance budget** — added a Client Component (`Sidebar`) for
      `usePathname()`, but it ships only a single `<Link>` map + class
      strings. Topbar is a Server Component (zero JS shipped beyond the
      `<ThemeToggle>` button it nested in Phase 0). First-load JS budget
      (< 200 KB) remains comfortable; will re-verify at phase-end build.

## Issues found

- **None blocking.** The full production-build verification is deferred to
  loop step 15 (per the plan's phase test stage), not per-task — typecheck
  + unit tests are the per-task gate.
- **Minor / observational:**
  - The shadcn `Input` primitive's existing styling renders the disabled
    search box correctly in dark mode, but in light mode the placeholder
    contrast may be a touch low. T11 (empty / error / loading polish) and
    T12 (theme polish) will revisit. **Decision: defer.**
  - The user-menu placeholder is intentionally a non-interactive `<div>` —
    it becomes a real menu in T02 (auth) once `/login` + logout exist.
    **Decision: defer to T02.**

## Verification trail

- `bun test` → 23 pass / 0 fail (logged above).
- `bun run typecheck` → clean exit.
- Browser/manual smoke deferred to loop step 16 (Playwright or manual
  walkthrough at phase end).

## Sign-off

T01 complete. Ready for T02 (auth middleware) on next iter.
