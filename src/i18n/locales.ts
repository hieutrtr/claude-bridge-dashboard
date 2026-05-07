// P4-T12 — Locale registry + cookie name + pure resolver. Kept
// dependency-free (no i18next import) so the module is safe to read
// from middleware, route handlers, server components, and tests.

export const LOCALES = ["en", "vi"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

// Cookie is httpOnly=false on purpose — the client `LanguageSwitcher`
// rewrites it via `document.cookie` for an instant switch (no API
// round-trip). The server still reads it via `cookies()` on the next
// render.
export const LOCALE_COOKIE = "bridge_locale";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  vi: "Tiếng Việt",
};

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

// Resolve any cookie / header / query value to a supported locale.
// The default fallback returns `DEFAULT_LOCALE` ("en") for anything
// unrecognised — including empty string, null, undefined, or a
// supported-prefix-with-region like `"vi-VN"` (we strip the region).
export function resolveLocale(value: string | null | undefined): Locale {
  if (!value) return DEFAULT_LOCALE;
  const lower = value.toLowerCase();
  if (isSupportedLocale(lower)) return lower;
  const base = lower.split(/[-_]/)[0];
  if (isSupportedLocale(base)) return base;
  return DEFAULT_LOCALE;
}
