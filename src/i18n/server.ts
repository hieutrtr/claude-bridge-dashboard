// P4-T12 — Server-side locale resolver. Server components call
// `getServerLocale()` to read the `bridge_locale` cookie and resolve
// it to a supported locale (with fallback). Then `getT(locale)`
// returns a translator bound to that locale.

import { cookies } from "next/headers";

import { LOCALE_COOKIE, resolveLocale, type Locale } from "./locales";
import { getFixedT, type TranslateFn } from "./format";

export async function getServerLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return resolveLocale(value);
}

export async function getServerT(): Promise<{ locale: Locale; t: TranslateFn }> {
  const locale = await getServerLocale();
  return { locale, t: getFixedT(locale) };
}
