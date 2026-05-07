"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Button } from "@/src/components/ui/button";
import { nextTheme, type Theme } from "@/src/lib/theme";

// P4-T10 — Sun/moon SVGs are inlined to avoid a new dependency
// (e.g. lucide-react would add ~30 kB just for two glyphs). The
// icons are aria-hidden because the button itself carries the
// `aria-label` describing the next state — assistive tech reads
// "Switch to light theme" rather than "Sun, button".
function SunIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon="sun"
      {...props}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function MoonIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon="moon"
      {...props}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

// Presentational view — pure props in, JSX out. Extracted so we can
// snapshot the markup with `renderToStaticMarkup` for each (mounted,
// resolved, next) tuple without needing a real <ThemeProvider> in
// the test runner. Mirrors the `<CommandPaletteView>` pattern.
export interface ThemeToggleViewProps {
  mounted: boolean;
  resolvedTheme: Theme | null | undefined;
  next: Theme;
  onToggle?: () => void;
}

export function ThemeToggleView({
  mounted,
  resolvedTheme,
  next,
  onToggle,
}: ThemeToggleViewProps) {
  // Pre-mount placeholder — same dimensions, no theme assertions.
  // A screen reader user pre-hydration sees a button announcing
  // "Theme toggle, loading"; the moon glyph hints at the dark default.
  if (!mounted) {
    return (
      <Button
        variant="outline"
        size="sm"
        aria-label="Theme toggle, loading"
        data-testid="theme-toggle"
        data-mounted="false"
        className="h-11 min-w-[44px] sm:h-9 gap-1.5"
        suppressHydrationWarning
      >
        <MoonIcon />
        <span className="sr-only sm:not-sr-only">Theme</span>
      </Button>
    );
  }

  const Icon = next === "dark" ? MoonIcon : SunIcon;
  const visibleLabel = next === "dark" ? "Dark" : "Light";
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      data-testid="theme-toggle"
      data-mounted="true"
      data-theme-current={resolvedTheme ?? "dark"}
      data-theme-next={next}
      onClick={onToggle}
      className="h-11 min-w-[44px] sm:h-9 gap-1.5"
    >
      <Icon />
      <span className="sr-only sm:not-sr-only">{visibleLabel}</span>
    </Button>
  );
}

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  // Mounted gate avoids a hydration-mismatch warning on the
  // aria-label / icon / data-* attributes. The server renders the
  // placeholder; the very first client render also uses it (because
  // `mounted` starts at false), so SSR and pre-effect client agree.
  // Once the effect runs we re-render with the resolved theme.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const next = nextTheme(theme, resolvedTheme);
  return (
    <ThemeToggleView
      mounted={mounted}
      resolvedTheme={(resolvedTheme as Theme | null | undefined) ?? null}
      next={next}
      onToggle={() => setTheme(next)}
    />
  );
}
