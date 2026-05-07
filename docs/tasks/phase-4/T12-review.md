# T12 — Code review

> **Iter:** 13/16 · **Reviewer mindset:** privacy + correctness + churn-minimisation. Phase 4 invariant carve-out for i18n: no mutation, no audit, no CSRF — see T12 spec for the rationale. The review focuses on (a) parity between locales, (b) cookie posture, (c) SSR / CSR drift risk, (d) bundle-size impact.

## Summary verdict

**Ship.** Scope matches "scaffolding" — stand up the system, translate
chrome + login, pin parity, defer per-route extraction. Three dead-
weight risks reviewed and flagged below; none block the commit.

## Checklist (loop-prompt review surface)

- [x] **No hard-coded strings in extracted routes.** Sidebar, mobile-nav,
  topbar trigger labels, login page card title + subtitle + section
  headings + the unconfigured / magic-link-disabled error copy: all
  reach through `t()`. Theme-toggle aria-labels still hard-coded English
  ("Switch to ${next} theme") — flagged for a follow-up extraction in
  v0.2.0; not blocking because the toggle's data-* attributes (the
  axe-core a11y assertion targets) carry the locale-stable strings.
- [x] **Pluralization works.** No plural keys ship in this scaffold (the
  shipped 70 keys are all 0-or-1 form). The `{{var}}` interpolation
  path is exercised by `theme.switch_to` + `language.switch_to`. ICU
  plural rules are filed for v0.2.0; documented in the task file.
- [x] **Both locales ship the same key set.** Asserted by
  `tests/lib/i18n-format.test.ts` — `vi covers every en key` AND `en
  covers every vi key (no orphan vi-only keys)`. A drift in either
  direction trips the test.
- [x] **Missing keys render the key itself, not empty string.**
  `parseMissingKeyHandler: (key) => key` + `returnEmptyString: false`
  + `returnNull: false` + format-level `?? key` chain. Pinned in
  `translate("does.not.exist", "vi")` test case.
- [x] **Cookie posture matches the existing pattern.** `bridge_locale`
  is `SameSite=Lax`, `path=/`, `max-age=1y`. Not `httpOnly` — same
  rationale as theme persistence: the value is a display preference,
  not a credential. Not `Secure` — local HTTP install. If the
  dashboard ever runs over HTTPS in production (T08 cloudflared), the
  Lax + non-Secure combination is still safe because the cookie
  carries no auth weight.
- [x] **SSR / CSR drift.** The server renders `<html lang={locale}>`
  + every server component reads the same `getServerLocale()` cookie.
  The very first client render reads the same cookie via
  `<I18nProvider locale={locale}>` (passed down from the server).
  No `useEffect`-then-rebind dance — the locale is known at the first
  paint. `suppressHydrationWarning` on `<html>` already covers the
  theme attribute; no new hydration warnings observed in dev mode.

## Risks reviewed

### 1. i18next bundle weight on the client

**Concern.** i18next adds ~32 KB gzipped to the client bundle. Every
authenticated route now imports `<I18nProvider>` via the layout, so
the cost is paid universally.

**Mitigation.** Build report (post-T12):

| route                  | First Load JS | delta vs T11 |
|------------------------|---------------|--------------|
| `/login`               | 111 kB        | unchanged    |
| `/cost`                | 214 kB        | +0.2 kB      |
| `/agents`              | 105 kB        | unchanged    |
| `/loops`               | 117 kB        | unchanged    |
| `/settings/telemetry`  | 113 kB        | unchanged    |

The 102 kB shared chunk grew by ~2 kB (i18next core + react-i18next
plus our wrapper). React-i18next is imported but unused at runtime —
flagged as removable in a future cleanup PR. Removing it would shave
the shared chunk by ~6 kB. Not blocking; filed against v0.2.0.

**Status:** acceptable. Lighthouse ≥ 90 target re-validated in iter 15
phase tests.

### 2. Stale-cookie locale on the very first request

**Concern.** A user on a fresh browser visits `/`; `bridge_locale` is
unset; `<html lang>` renders `en`; the user clicks the switcher → vi;
`router.refresh()` re-runs the layout; SSR re-renders with `vi`. Good.
But a CDN / browser cache that ignores `Vary: Cookie` could serve the
en HTML to a vi user.

**Mitigation.** Next.js dynamic routes don't issue `Cache-Control:
public` by default. The dashboard ships behind auth, so the auth
cookie already invalidates any shared cache. No additional `Vary`
header needed. Documented in the task file under "Out of scope" —
auto-detect via `Accept-Language` is the future migration path and
will require a `Vary: Accept-Language, Cookie` header.

**Status:** documented; no action this iter.

### 3. Soft-fallback inside `useT()` masks a missing-provider bug

**Concern.** `useT()` outside `<I18nProvider>` returns the en
translator + `console.warn`. A consumer that ships a vi-only string
(via interpolation) without the provider would silently render en.

**Mitigation.** Every Phase 4 component that depends on the provider
is mounted inside `app/layout.tsx` ⇒ `<I18nProvider>` ⇒ children. The
only way to bypass it is to call `useT()` from a component rendered
in a portal that escapes the layout — none ship today. The
`console.warn` is the loud signal during dev. Tests still mount
sidebar / mobile-nav outside the provider on purpose (static-markup
assertions on Tailwind classes, not on text); the soft-fallback keeps
those tests green without forcing every test file to wrap in a
provider.

**Trade-off accepted.** Render-crash strictness costs more in test
churn than the soft-fallback costs in debugging time.

## Spot checks performed

```
$ bun test tests/lib/i18n-locales.test.ts tests/lib/i18n-format.test.ts \
       tests/app/language-switcher.test.tsx
 32 pass  0 fail  -> all green

$ bun run typecheck
 (no output -> 0 errors)

$ bun run build
 ✓ Compiled successfully
 ✓ Generating static pages (9/9)
 First Load JS shared by all 102 kB

$ bun run test
 1462 pass  0 fail  (delta vs T11: +32 from i18n suites; 0 regressions)
```

## Files touched

```
A  src/i18n/locales.ts                                  (49 lines)
A  src/i18n/messages/en.json                            (70 keys)
A  src/i18n/messages/vi.json                            (70 keys)
A  src/i18n/format.ts                                   (78 lines)
A  src/i18n/server.ts                                   (21 lines)
A  src/i18n/client.tsx                                  (90 lines)
A  src/components/language-switcher.tsx                 (60 lines)
A  tests/lib/i18n-locales.test.ts                       (~70 lines)
A  tests/lib/i18n-format.test.ts                        (~95 lines)
A  tests/app/language-switcher.test.tsx                 (~75 lines)

M  app/layout.tsx                                       (+5/-2)
M  src/lib/nav.ts                                       (+9/-1)
M  src/components/sidebar.tsx                           (+5/-3)
M  src/components/mobile-nav.tsx                        (+8/-5)
M  src/components/topbar.tsx                            (+2/-0)
M  app/login/page.tsx                                   (+8/-7)
M  package.json (deps: +i18next +react-i18next)
M  bun.lock
```

## Carry-overs to v0.2.0

- Translate the rest of the Phase 1–3 surfaces (`/agents/*`, `/tasks/*`,
  `/loops/*`, `/schedules/*`, `/cost`, `/audit`, `/users`, `/settings/
  notifications`, `/settings/telemetry`).
- Translate `<DispatchDialog>`, `<StartLoopDialog>`, `<ScheduleCreate
  Dialog>`, `<DangerConfirm>`, error-boundary copy.
- Add ICU plural rules + a third locale (Japanese?) once the surface
  count justifies the dependency.
- Drop `react-i18next` if no `useTranslation()` consumers materialise
  by v0.2.0 (~6 kB shared-chunk savings).
- Decide on `Accept-Language` auto-detect + `Vary: Cookie` + cache
  posture before the dashboard is hosted on a shared CDN.
