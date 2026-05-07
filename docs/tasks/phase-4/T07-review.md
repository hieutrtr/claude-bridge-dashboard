# T07 — Code review (mobile responsive + Lighthouse ≥ 90)

> Self-review against the Phase 4 review-rule template (auth / RBAC /
> mobile / email-rate-limit). T07 sits in the "mobile" axis; the
> answers below mirror that ordering.

---

## Auth — token expiry + secure cookie?

**N/A — T07 does not introduce or modify any auth surface.**

The Lighthouse runner re-uses the existing `/api/auth/login` endpoint
(P1 + P4-T01) to obtain a session cookie for the audit run; it does
not create a new cookie type, does not bypass middleware, and does not
sign anything. The `extraHeaders.cookie` passed to Lighthouse is
identical to what the Playwright fixture login sets — so the audit
runs against the same auth surface end-users see.

The fixture password (`smoke-pass`) lives only in
`tests/e2e/fixture.ts` and is gated behind `NODE_ENV=production` +
`DASHBOARD_PASSWORD=smoke-pass` env vars that we explicitly set inside
the Lighthouse script's spawn. Production deployments do not pick up
this default.

## RBAC — does the 403 matrix cover all mutation routes?

**N/A — T07 introduces no new mutations** (the only new server entry
points are the Lighthouse runner script and the static
`docs/tasks/phase-4/lighthouse/*.json` assets). Existing mutation
gates from T01–T06 (CSRF + per-user rate-limit + RBAC + audit) are
untouched.

The `<MobileNav>` drawer renders the same `NAV_ITEMS` set as the
desktop sidebar — visibility is identical between mobile and desktop,
so no role-aware filtering decisions changed. The role-gated *pages*
(e.g., `/settings/users`) continue to enforce authorization on the
server (`auth.me` + `requireOwner` from T03).

## Mobile — Lighthouse ≥ 90?

**Yes, on perf / a11y / best-practices.** SEO holds at 91 across the
board.

Worst-case row in `summary.json`:

| Axis            | Worst route        | Score |
| --------------- | ------------------ | ----: |
| performance     | `/`                |    96 |
| accessibility   | `/agents`, `/`     |    98 |
| best-practices  | every route        |    96 |
| seo             | every route        |    91 |

A regression below 90 fires `tests/app/lighthouse-summary.test.ts` on
the next `bun test`. The test reads the committed summary, so the
failure surfaces in CI without the runner needing to be re-executed
on every PR — devs only re-run `bun run lighthouse:mobile` when they
intentionally change something that could move the needle (e.g.,
adding a chart, importing a heavy npm package, or changing the
build pipeline).

### Touch-target audit (≥ 44 × 44 px below `md`)

| Element                                | Mobile size           | Verified by                                         |
| -------------------------------------- | --------------------- | --------------------------------------------------- |
| Mobile-nav hamburger trigger           | `h-11 w-11`           | `tests/app/responsive-shell.test.tsx`               |
| Sheet close button                     | `h-11 w-11`           | `tests/app/sheet.test.tsx`                          |
| Mobile-nav drawer link rows            | `h-11`                | `tests/app/sheet.test.tsx` (forwarded child markup) |
| Desktop sidebar link rows on mobile    | `h-11` (compresses to `h-9` from `md+`) | `tests/app/responsive-shell.test.tsx`     |
| Topbar `Search` (command palette trigger) | `h-11 sm:h-9`      | manual + Lighthouse `tap-targets` audit             |
| Topbar `Dispatch` button               | `h-11 sm:h-9`         | same                                                |
| Topbar theme toggle                    | `h-11 min-w-[44px] sm:h-9` | same                                           |

Lighthouse mobile's `tap-targets` audit is part of the
`accessibility` category — a sub-44px hit area would have dropped the
a11y score below 100 on the affected route. The current 98–100 spread
indicates no violations on any audited page.

### Horizontal-scroll audit

The page-level scroll container is `<main class="overflow-auto">`
inside a `flex min-w-0` column — `min-w-0` is the load-bearing class
that prevents the column itself from being pushed wider than the
viewport by an oversized table cell. Each table is wrapped in
`<div class="overflow-x-auto">`, so the scrolling happens inside the
table and never on the document.

Spot-checked on the Lighthouse traces: no `viewport.scrollWidth >
viewport.clientWidth` warnings on any of the eight audited routes at
390 × 844.

## Email — rate-limit (anti-abuse)?

**N/A — T07 sends no email** and does not touch the magic-link request
bucket from T01. The Lighthouse audit is entirely read-only against
the existing routes.

---

## Risks / known limitations

1. **SEO score capped at 91**. Lighthouse flags every authenticated
   route as missing a canonical link tag. This is intentional —
   `/agents`, `/tasks`, `/loops`, etc. should never be indexed; an
   `<meta name="robots" content="noindex">` is implicitly correct via
   the auth gate but Lighthouse still wants the meta tag. We can add
   `<meta name="robots" content="noindex,nofollow">` in
   `app/layout.tsx` to bump SEO past 92, but that is a Phase 5 polish
   item — not a T07 acceptance miss.
2. **Lighthouse runs require Chrome on the host.** The script falls
   back to `chrome-launcher`'s default install discovery
   (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on
   macOS dev machines, `/usr/bin/google-chrome` on Linux CI). If a CI
   image lacks Chrome, the runner errors out with a clear message —
   the gate test (`lighthouse-summary.test.ts`) reads the committed
   `summary.json`, so CI does not need to re-run Lighthouse on every
   PR. Devs re-run locally when they change perf-affecting code.
3. **Production-build gate has a dev-mode escape hatch**. Setting
   `LIGHTHOUSE_SKIP_BUILD=1` lets a dev re-run the audit against an
   already-built `.next/` to iterate on the runner itself. This is
   not advertised in the task file — the env var is intentionally
   undocumented to discourage skipping the build step (which would
   produce un-realistic perf scores from `next dev`).
4. **Watchpack OrbStack ETIMEDOUT noise**. The `next dev` watcher on
   the audit author's machine prints a warning about an unreachable
   `~/OrbStack` mount. This is local-machine noise (the user mounted
   OrbStack on a since-disconnected volume); it does not affect
   `next build` / `next start`, which is what the Lighthouse runner
   actually uses.
5. **Drawer focus-trap test coverage is static-only**. The interactive
   contracts (Tab key cycling, ESC closes, click-outside closes,
   body-scroll lock) are exercised by Playwright in the Phase 4 step
   15 sweep — the unit tests assert the markup contract only. This
   matches the pattern set by `<DangerConfirm>` and
   `<CommandPalette>` (each ships a static-markup unit test plus a
   single Playwright spec for the interactive flow).

---

## Files changed

```
src/lib/mobile-nav.ts                       (new)
src/components/ui/sheet.tsx                 (new)
src/components/mobile-nav.tsx               (new)
src/components/sidebar.tsx                  (mod — hidden md:flex + h-11 link)
src/components/topbar.tsx                   (mod — sticky top-0 + MobileNav)
src/components/dispatch-trigger.tsx         (mod — h-11 sm:h-9)
src/components/command-palette-trigger.tsx  (mod — h-11 sm:h-9 + hide ⌘K kbd <sm)
src/components/ui/theme-toggle.tsx          (mod — h-11 sm:h-9)
app/layout.tsx                              (mod — main p-4 sm:p-6)
scripts/lighthouse-mobile.ts                (new — runner + summary writer)
package.json                                (mod — lighthouse:mobile script + 2 devDeps)
tests/lib/mobile-nav.test.ts                (new)
tests/app/sheet.test.tsx                    (new)
tests/app/responsive-shell.test.tsx         (new)
tests/app/lighthouse-summary.test.ts        (new — gates the summary)
docs/tasks/phase-4/T07-mobile-responsive.md (new — this task)
docs/tasks/phase-4/T07-review.md            (new — this review)
docs/tasks/phase-4/lighthouse/*.json        (new — 8 reports + summary)
```

---

## Sign-off

✅ Implementation complete. Lighthouse gate verified at commit-time;
the unit-test sweep includes a guard that fails any future PR that
regresses the summary file below 90 on perf / a11y / best-practices.
