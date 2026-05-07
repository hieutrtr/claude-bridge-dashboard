// P4-T12 — i18next instance + curried translator. Used by server
// `getT(locale)` and the client `useT()` hook so SSR and CSR behave
// identically (same key lookup, same en fallback, same {{var}}
// interpolation). One singleton instance per process — i18next
// `getFixedT(lng)` is allocation-light and reads from a shared
// resource bag, so per-locale state does NOT leak across requests.

import i18next, { type i18n as I18n } from "i18next";

import en from "./messages/en.json" assert { type: "json" };
import vi from "./messages/vi.json" assert { type: "json" };

import { DEFAULT_LOCALE, LOCALES, type Locale } from "./locales";

export type Messages = Readonly<Record<string, string>>;

export const MESSAGES: Readonly<Record<Locale, Messages>> = {
  en: en as Messages,
  vi: vi as Messages,
};

// Lazy-init the singleton. We want `init()` to run exactly once even
// if the module is loaded from multiple entry points (server + client
// bundles in dev, RSC + browser bundles in prod).
let initialized = false;
function ensureInit(): I18n {
  if (initialized) return i18next;
  // `initAsync: false` makes init synchronous so the very first
  // `getFixedT()` call doesn't race the resource loader.
  i18next.init({
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...LOCALES],
    resources: {
      en: { translation: MESSAGES.en },
      vi: { translation: MESSAGES.vi },
    },
    interpolation: {
      // Next.js + React already escape strings. i18next's escaper would
      // double-escape `&` etc. on the server.
      escapeValue: false,
    },
    returnNull: false,
    returnEmptyString: false,
    initAsync: false,
    // When a key is missing in BOTH the active locale and the fallback,
    // surface the key itself so the UI flags the gap during dev.
    parseMissingKeyHandler: (key: string) => key,
  });
  initialized = true;
  return i18next;
}

export type TranslateParams = Readonly<Record<string, string | number>>;

// Curried translator. Mirrors `i18next.getFixedT(lng)`'s signature so
// call sites can be migrated to the bare i18next API without churn if
// we ever need plural/ICU support.
export type TranslateFn = (key: string, params?: TranslateParams) => string;

export function getFixedT(locale: Locale): TranslateFn {
  const i = ensureInit();
  const t = i.getFixedT(locale, "translation");
  return (key, params) =>
    // i18next returns the key when missing thanks to the
    // `parseMissingKeyHandler` above; we cast through `string` because
    // i18next's TS types union with `TFunctionResult`.
    t(key, params as Record<string, unknown> | undefined) as string;
}

// One-shot translate (server actions, route handlers). Avoid in render
// — use `getFixedT(locale)` once and reuse the closure.
export function translate(
  key: string,
  locale: Locale,
  params?: TranslateParams,
): string {
  return getFixedT(locale)(key, params);
}
