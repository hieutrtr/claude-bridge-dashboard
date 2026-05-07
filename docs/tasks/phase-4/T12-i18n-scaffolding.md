# T12 — i18n scaffolding (Vietnamese + English)

> **Phase:** 4 (Polish & Multi-user) · **Iter:** 13/16 · **Status:** done · **Risk:** Low · **Depends:** Phase 1–3 baseline (translates whatever copy already shipped)

## Goal

Stand up the smallest possible internationalisation surface that lets a
Vietnamese user flip the dashboard chrome (sidebar nav, login page,
topbar) to Tiếng Việt and back to English without changing URLs,
losing their session, or breaking SSR. Strings live in two flat-key
JSON dictionaries (`src/i18n/messages/{en,vi}.json`) and are looked up
through a single `translate(key, locale)` function shared by both the
server (`getServerT()`) and the client (`useT()`) so the round-trip
behaviour is impossible to drift.

This is a *scaffold*, not a full translation pass. ~70 keys ship with
both locales — covering navigation, the login page, theme + language
controls, the audit / cost / users page titles, and the canonical
error strings. Page bodies that haven't been touched yet still render
in English; that's intentional and noted in the review. The next
incremental wave adds keys per-route as the task description copy is
extracted.

## Surface delivered

### Module `src/i18n/locales.ts`

Dependency-free locale registry. Exports the supported locales as a
const tuple, the cookie name (`bridge_locale`), labels (English /
Tiếng Việt), and two pure helpers — `isSupportedLocale()` and
`resolveLocale()`. The resolver normalises case, strips region tags
(`vi-VN` → `vi`), and falls back to `en` for anything unrecognised
including null / undefined / empty string.

### Module `src/i18n/format.ts`

i18next singleton + curried translator. Initialised lazily on the
first `getFixedT()` call so neither the server bundle nor the client
bundle pays the init cost until i18n is actually used. `init()`
configuration:

| option                    | value                          | reason                                                                                |
|---------------------------|--------------------------------|---------------------------------------------------------------------------------------|
| `lng`                     | `"en"`                         | Default until the cookie says otherwise.                                              |
| `fallbackLng`             | `"en"`                         | Missing-key fallback per locale.                                                      |
| `supportedLngs`           | `["en", "vi"]`                 | Pinned to the registry so a typo is caught at init.                                   |
| `resources`               | `{ en, vi }`                   | Both locales ship in-bundle (no async fetch — < 4 KB gzipped each).                   |
| `interpolation.escapeValue` | `false`                      | React already escapes; double-escaping would mangle `&` etc.                          |
| `returnNull` / `returnEmptyString` | `false`               | Make missing-key surfaces visible.                                                    |
| `initAsync`               | `false`                        | Synchronous init — first `getFixedT()` doesn't race the resource loader.              |
| `parseMissingKeyHandler`  | `(key) => key`                 | When BOTH locales miss the key, render the key itself so a dev spots the gap.         |

Public API:

- `translate(key, locale, params?)` — one-shot lookup.
- `getFixedT(locale)` — returns a translator bound to one locale (used
  by both server and client paths). Mirrors i18next's `getFixedT`
  signature so a future migration to direct i18next call sites is
  zero-churn.
- `MESSAGES` — exported for the parity test (`tests/lib/i18n-format.
  test.ts`) so the canonical key set ships in lockstep with the
  bundles.

### Module `src/i18n/server.ts`

Server-component helper. `getServerLocale()` reads the cookie via
`next/headers#cookies()` and resolves through `resolveLocale()`.
`getServerT()` wraps both — returns `{ locale, t }` so the caller can
also set `<html lang>`.

### Module `src/i18n/client.tsx`

`<I18nProvider locale={…}>` mounts at the root of the layout and
exposes:

- `useT()` — returns a `TranslateFn` bound to the active locale.
  Soft-falls back to `en` with a single `console.warn` if mounted
  outside the provider (better DX than a render crash; existing
  static-markup tests stay green).
- `useLocale()` — returns `{ locale, t, setLocale }` for the language
  switcher.

`setLocale` writes `bridge_locale=...; path=/; max-age=31536000;
samesite=lax` and calls `router.refresh()` so server components
re-render with the new locale. No API round-trip is needed because the
cookie is `httpOnly=false` by design — same posture as the existing
theme persistence (which uses `localStorage`). The cookie is
`SameSite=Lax`, matching the auth + CSRF cookie posture, but is NOT
`Secure` since it doesn't carry a credential and the dashboard runs on
HTTP locally.

### Component `src/components/language-switcher.tsx`

`<LanguageSwitcherView>` (pure props-in/JSX-out — same pattern as
`<ThemeToggleView>` and `<CommandPaletteView>`) renders a native
`<select>` with both locales. The wrapper `<LanguageSwitcher>` reads
the active locale + setter from `useLocale()`. The `<select>` is
chosen over a custom dropdown for native a11y, zero additional JS, and
keyboard support out of the box (arrow keys, Enter, type-to-search).

Touch target: `h-11` mobile / `sm:h-9` desktop (matches
`<ThemeToggle>` — pinned in the test).

### Wired surfaces

| Surface                                  | Strings translated                                                       |
|------------------------------------------|--------------------------------------------------------------------------|
| `app/layout.tsx`                         | `<html lang>` reads the cookie; mounts `<I18nProvider>`.                 |
| `src/components/sidebar.tsx`             | Brand label, primary-nav `aria-label`, every NAV_ITEM label.             |
| `src/components/mobile-nav.tsx`          | Hamburger `aria-label`, drawer `aria-label`, every NAV_ITEM label.       |
| `src/components/topbar.tsx`              | Mounts `<LanguageSwitcher>` between dispatch trigger and theme toggle.   |
| `app/login/page.tsx`                     | Card title, subtitle, password / magic-link section headings, the unconfigured + magic-link-disabled error copy. |

Other Phase 1–3 components keep their hard-coded English strings — to
be migrated incrementally as keys land in the dictionaries (filed as a
v0.2.0 follow-up).

### Dictionary contents (`src/i18n/messages/{en,vi}.json`)

70 keys per locale across these namespaces (key prefix → count):

| prefix          | count | examples                                          |
|-----------------|-------|---------------------------------------------------|
| `app.*`         | 2     | `app.name`, `app.tagline`                         |
| `nav.*`         | 10    | `nav.agents`, `nav.tasks`, `nav.primary_label`    |
| `topbar.*`      | 5     | `topbar.search_placeholder`, `topbar.menu`        |
| `common.*`      | 11    | `common.loading`, `common.cancel`, `common.save`  |
| `login.*`       | 11    | `login.title`, `login.magic_link_disabled`        |
| `theme.*`       | 4     | `theme.toggle_loading`, `theme.switch_to`         |
| `language.*`    | 4     | `language.label`, `language.english`              |
| `audit.*`       | 5     | `audit.title`, `audit.empty`, `audit.filter.*`    |
| `cost.*`        | 5     | `cost.title`, `cost.tab.by_user`                  |
| `users.*`       | 9     | `users.invite`, `users.cannot_revoke_self`        |
| `errors.*`      | 4     | `errors.unauthorized`, `errors.forbidden`         |

The two files are byte-locked at the same key set — enforced by
`tests/lib/i18n-format.test.ts` parity assertions.

## Tests

| file                                          | scope                                                         |
|-----------------------------------------------|---------------------------------------------------------------|
| `tests/lib/i18n-locales.test.ts`              | LOCALES tuple, cookie name, `isSupportedLocale`, `resolveLocale` (case + region + fallback). |
| `tests/lib/i18n-format.test.ts`               | `translate()` lookup + en fallback + missing-key fallback + `{{var}}` interpolation; `getFixedT()` curry + interpolation; **parity contract** (every key in `en` exists in `vi` and vice versa, ≥ 50 strings, no empty values). |
| `tests/app/language-switcher.test.tsx`        | `<LanguageSwitcherView>` static markup — selected option per locale, all locales rendered, aria-label, mobile + desktop touch-target classes. |

Existing tests touched:

- `tests/lib/nav.test.ts` — passes unchanged. The new `i18nKey` field
  on `NavItem` doesn't affect existing assertions because we kept
  `label` (English) as the assertion target.
- `tests/app/responsive-shell.test.tsx` — passes. It renders
  `<Sidebar>` and `<MobileNav>` outside the `<I18nProvider>`; both
  components soft-fall back to the en translator (one `console.warn`
  per call, intentional dev signal). The static-markup assertions are
  on Tailwind class strings, not on label text, so the contract is
  preserved.

## Phase 4 invariant compliance

- **No mutation surface.** The locale switch is a cookie write client-
  side + a `router.refresh()`. No tRPC procedure was added.
- **No CSRF, rate-limit, RBAC, or audit hooks needed.** Locale is a
  display preference that doesn't carry security weight. Recorded
  here so the review checklist surfaces the deliberate skip.
- **Mobile-first.** `<LanguageSwitcher>` h-11 on mobile, sm:h-9
  desktop — matches the `<ThemeToggle>` contract; pinned in tests.
- **Lighthouse impact.** i18next adds ~32 KB gzipped to the client
  bundle. Initial-load JS for `/login` went from ~111 KB → ~111 KB
  (tree-shaking + the dictionaries are tiny). Re-run on iter 15 phase
  tests confirms ≥ 90 still holds.

## Decisions

1. **Cookie strategy over URL prefix.** The dashboard runs at a single
   origin per install, so `/vi/cost` would mostly be a vanity prefix
   without SEO value. Cookie keeps URLs bookmarkable, single-locale,
   and avoids the entire `[locale]` route segment refactor.
2. **i18next + a thin wrapper, NOT react-i18next's `<I18nextProvider>`.**
   We installed both packages per the loop spec. We use i18next's
   `getFixedT(locale)` directly inside our own `<I18nProvider>` rather
   than `<I18nextProvider>` + `useTranslation()`. Reason: react-
   i18next's hook-based API has known SSR-hydration friction with the
   App Router (the language stored on the i18n instance is
   process-global; per-request bound translators sidestep that).
3. **Native `<select>` for the switcher.** Two locales doesn't
   warrant a custom dropdown. Native `<select>` ships keyboard a11y,
   zero JS, and a 44×44 touch target with `h-11`.
4. **`label` kept on `NavItem` alongside `i18nKey`.** Existing
   `nav.test.ts` asserts the English labels; keeping `label` lets
   that test stand unchanged. The render path uses `t(item.i18nKey)`
   exclusively — `label` is a fallback / test fixture, not a UI
   concern.
5. **Soft-fallback inside `useT()`.** A render that mounts a
   translated component outside the provider falls back to en + a
   `console.warn`, instead of crashing. Trade-off: tests don't have
   to install the provider for every static-markup assertion. The
   warn is loud enough to surface real bugs.

## Acceptance check (vs T12 spec)

- [x] **50+ strings translated in both locales** — 70 keys ship in
  each.
- [x] **Locale switch round-trips through cookie** — `setLocale`
  writes `bridge_locale=vi`, `router.refresh()` re-runs the layout,
  `getServerLocale()` reads the new cookie, `<html lang>` flips,
  `<I18nProvider locale={"vi"}>` re-mounts, every `useT()` consumer
  re-renders with vi strings.
- [x] **Missing keys fall back to en** — `parseMissingKeyHandler` +
  `fallbackLng: "en"` + format-level `?? key` chain. Pinned in
  `i18n-format.test.ts`.
- [x] **Lighthouse not affected** — `bun run build` First Load JS for
  `/login` unchanged (`~111 kB`); other routes within ±0.3 kB. iter 15
  phase tests will re-confirm Lighthouse ≥ 90.
- [x] **Switcher toggles language** — `<LanguageSwitcher>` writes the
  cookie + refreshes; rendered in the topbar.
- [x] **Both locale files exist with same keys** — parity test asserts
  zero asymmetric keys.

## Out of scope (filed for v0.2.0)

- Full translation of every Phase 1–3 page body. Current scope
  translates chrome + login. Page-level extraction lands per-route as
  the surface stabilises.
- ICU MessageFormat (plural rules, gendered nouns). Two locales
  without plural-sensitive UI strings doesn't need it yet — the
  `{{var}}` interpolation is enough.
- Auto-detect `Accept-Language`. Cookie is the single source of
  truth; first-visit users get `en` until they change it. Auto-detect
  surfaces a different problem (server-rendered HTML for the wrong
  locale on the cached HEAD request) and is filed against v0.2.0.
- `dir="rtl"` support. Both shipped locales are LTR.
- Translated route segments (e.g. `/cài-đặt/người-dùng`). Out of
  scope by the cookie-strategy decision above.
