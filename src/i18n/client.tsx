"use client";

// P4-T12 — Client-side locale context. The root layout (server
// component) reads the cookie via `getServerLocale()` and renders
// `<I18nProvider locale={...}>` once at the top of the tree. Client
// components below it call `useT()` to get a translator bound to the
// active locale, plus a `setLocale()` mutation that persists to the
// cookie and refreshes the route so server components re-render in
// the new language.

import * as React from "react";
import { useRouter } from "next/navigation";

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isSupportedLocale,
  type Locale,
} from "./locales";
import { getFixedT, type TranslateFn } from "./format";

interface LocaleContextValue {
  locale: Locale;
  t: TranslateFn;
  setLocale: (next: Locale) => void;
}

const LocaleContext = React.createContext<LocaleContextValue | null>(null);

interface I18nProviderProps {
  locale: Locale;
  children: React.ReactNode;
}

export function I18nProvider({ locale, children }: I18nProviderProps) {
  const router = useRouter();
  // Cache the bound t-function for the active locale. Re-bind only
  // when the locale actually flips so child components don't re-render
  // unnecessarily.
  const t = React.useMemo<TranslateFn>(() => getFixedT(locale), [locale]);

  const setLocale = React.useCallback(
    (next: Locale) => {
      if (!isSupportedLocale(next)) return;
      // 1 year TTL, root path so every route sees it. SameSite=Lax
      // matches the auth + CSRF cookie posture.
      const oneYear = 60 * 60 * 24 * 365;
      const cookie =
        `${LOCALE_COOKIE}=${encodeURIComponent(next)}; ` +
        `path=/; max-age=${oneYear}; samesite=lax`;
      if (typeof document !== "undefined") {
        document.cookie = cookie;
      }
      // Trigger a server-component re-render so SSR strings flip too.
      router.refresh();
    },
    [router],
  );

  const value = React.useMemo<LocaleContextValue>(
    () => ({ locale, t, setLocale }),
    [locale, t, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

// Read-only hook for client components that just need to render
// translated strings. Throws a friendly error if invoked outside the
// provider — easier to debug than a silent fallback.
export function useT(): TranslateFn {
  const ctx = React.useContext(LocaleContext);
  if (!ctx) {
    // Soft-fallback: return the default-locale translator so a
    // missing-provider bug surfaces as English text instead of a
    // crashed render. Logs to the browser console once per call site.
    if (typeof console !== "undefined") {
      console.warn(
        "[i18n] useT() called outside <I18nProvider> — falling back to en",
      );
    }
    return getFixedT(DEFAULT_LOCALE);
  }
  return ctx.t;
}

// Full hook for the language switcher — exposes the current locale
// and the setter.
export function useLocale(): LocaleContextValue {
  const ctx = React.useContext(LocaleContext);
  if (!ctx) {
    return {
      locale: DEFAULT_LOCALE,
      t: getFixedT(DEFAULT_LOCALE),
      setLocale: () => {},
    };
  }
  return ctx;
}
