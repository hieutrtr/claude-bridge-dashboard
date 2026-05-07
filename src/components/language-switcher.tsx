"use client";

// P4-T12 — Header dropdown that flips the active locale. Cookie-only
// strategy (no /vi/* URL prefix) — see INDEX §"Sequencing decision"
// "i18n strategy: cookie vs URL prefix" for the why. Keeps URLs
// bookmarkable and SEO-stable; the switcher mutates the cookie + a
// `router.refresh()` then SSR strings re-render in the new language.

import * as React from "react";

import { LOCALES, LOCALE_LABELS, type Locale } from "@/src/i18n/locales";
import { useLocale } from "@/src/i18n/client";
import { cn } from "@/src/lib/utils";

interface LanguageSwitcherViewProps {
  locale: Locale;
  ariaLabel: string;
  onChange: (next: Locale) => void;
  className?: string;
}

// Pure presentational view — same pattern as <ThemeToggleView>. Keeps
// the snapshot test light (no router, no provider).
export function LanguageSwitcherView({
  locale,
  ariaLabel,
  onChange,
  className,
}: LanguageSwitcherViewProps) {
  return (
    <label className={cn("inline-flex items-center", className)}>
      <span className="sr-only">{ariaLabel}</span>
      <select
        aria-label={ariaLabel}
        data-testid="language-switcher"
        data-locale-current={locale}
        value={locale}
        onChange={(e) => onChange(e.target.value as Locale)}
        className={cn(
          // Native <select> for zero-JS dropdown a11y. 44×44 touch
          // target on mobile (h-11) and a normal h-9 on desktop —
          // matches <ThemeToggle>'s sizing contract.
          "h-11 min-w-[88px] rounded-md border border-[hsl(var(--border))]",
          "bg-[hsl(var(--background))] px-2 text-sm text-[hsl(var(--foreground))]",
          "focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]",
          "sm:h-9",
        )}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, setLocale, t } = useLocale();
  return (
    <LanguageSwitcherView
      locale={locale}
      ariaLabel={t("language.label")}
      onChange={setLocale}
      className={className}
    />
  );
}
