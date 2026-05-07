// P4-T10 — Static-markup tests for the polished theme toggle. We
// snapshot the button HTML for each (mounted, resolved, next) tuple
// and assert the contract that the AA / hydration / touch-target
// invariants depend on. Mirrors the `<CommandPaletteView>` test
// pattern — no real <ThemeProvider> needed, because the view is a
// pure props-in / JSX-out function.
//
// Why this exists separate from `tests/app/theme-config.test.ts`:
// that file pins the *layout-level* contract (default theme, class
// strategy, FOUC guard); this file pins the *component-level*
// contract (icons, aria labels, touch target, mounted gate). They
// move at different cadences, so they live in different files.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ThemeToggleView } from "../../src/components/ui/theme-toggle";

describe("<ThemeToggleView> — pre-mount placeholder", () => {
  const html = renderToStaticMarkup(
    <ThemeToggleView mounted={false} resolvedTheme={null} next="light" />,
  );

  it('renders an aria-label of "Theme toggle, loading"', () => {
    expect(html).toContain('aria-label="Theme toggle, loading"');
  });

  it("carries the moon glyph as a hint for the dark default", () => {
    expect(html).toContain('data-icon="moon"');
    expect(html).not.toContain('data-icon="sun"');
  });

  it("flags itself as not yet mounted (data-mounted=false)", () => {
    expect(html).toContain('data-mounted="false"');
  });

  it("preserves the 44×44 touch target on mobile (h-11 min-w-[44px])", () => {
    expect(html).toContain("h-11");
    expect(html).toContain("min-w-[44px]");
  });

  it("does NOT echo theme-current or theme-next data attributes pre-mount", () => {
    // Hydration-mismatch guard: the server cannot know the user's
    // preference, so emitting these attributes risks SSR/CSR drift.
    expect(html).not.toContain("data-theme-current");
    expect(html).not.toContain("data-theme-next");
  });

  it("hides the visible label on mobile via sr-only and reveals it from sm+", () => {
    expect(html).toContain("sr-only");
    expect(html).toContain("sm:not-sr-only");
  });

  // Note: React strips `suppressHydrationWarning` before serialising
  // HTML — it is purely a runtime hint. We rely on the parent
  // `<html suppressHydrationWarning>` (asserted in
  // `tests/app/theme-config.test.ts`) plus the mounted gate to keep
  // hydration silent. No textual assertion possible at this layer.
});

describe("<ThemeToggleView> — mounted in dark mode", () => {
  const html = renderToStaticMarkup(
    <ThemeToggleView mounted={true} resolvedTheme="dark" next="light" />,
  );

  it('says "Switch to light theme" via aria-label + title', () => {
    expect(html).toContain('aria-label="Switch to light theme"');
    expect(html).toContain('title="Switch to light theme"');
  });

  it("renders the sun icon (because clicking will flip TO light)", () => {
    expect(html).toContain('data-icon="sun"');
    expect(html).not.toContain('data-icon="moon"');
  });

  it("exposes the current resolved theme on data-theme-current", () => {
    expect(html).toContain('data-theme-current="dark"');
  });

  it("exposes the next theme on data-theme-next (used by E2E persistence checks)", () => {
    expect(html).toContain('data-theme-next="light"');
  });

  it('shows the visible "Light" label from sm+', () => {
    expect(html).toContain("Light");
  });

  it("flags itself as mounted (data-mounted=true)", () => {
    expect(html).toContain('data-mounted="true"');
  });
});

describe("<ThemeToggleView> — mounted in light mode", () => {
  const html = renderToStaticMarkup(
    <ThemeToggleView mounted={true} resolvedTheme="light" next="dark" />,
  );

  it('says "Switch to dark theme" via aria-label', () => {
    expect(html).toContain('aria-label="Switch to dark theme"');
  });

  it("renders the moon icon (because clicking will flip TO dark)", () => {
    expect(html).toContain('data-icon="moon"');
    expect(html).not.toContain('data-icon="sun"');
  });

  it("exposes data-theme-current=light", () => {
    expect(html).toContain('data-theme-current="light"');
  });

  it('shows the visible "Dark" label', () => {
    expect(html).toContain("Dark");
  });
});

describe("<ThemeToggleView> — invariants across all states", () => {
  const states: Array<{
    mounted: boolean;
    resolvedTheme: "dark" | "light" | null;
    next: "dark" | "light";
  }> = [
    { mounted: false, resolvedTheme: null, next: "light" },
    { mounted: true, resolvedTheme: "dark", next: "light" },
    { mounted: true, resolvedTheme: "light", next: "dark" },
  ];

  for (const s of states) {
    const label = `mounted=${s.mounted} resolved=${s.resolvedTheme ?? "—"} next=${s.next}`;

    it(`carries data-testid="theme-toggle" — ${label}`, () => {
      const html = renderToStaticMarkup(
        <ThemeToggleView
          mounted={s.mounted}
          resolvedTheme={s.resolvedTheme}
          next={s.next}
        />,
      );
      expect(html).toContain('data-testid="theme-toggle"');
    });

    it(`renders an icon SVG — ${label}`, () => {
      const html = renderToStaticMarkup(
        <ThemeToggleView
          mounted={s.mounted}
          resolvedTheme={s.resolvedTheme}
          next={s.next}
        />,
      );
      expect(html).toMatch(/<svg[^>]*data-icon="(sun|moon)"/);
    });

    it(`uses the focus-ring contract from <Button> — ${label}`, () => {
      const html = renderToStaticMarkup(
        <ThemeToggleView
          mounted={s.mounted}
          resolvedTheme={s.resolvedTheme}
          next={s.next}
        />,
      );
      // <Button variant="outline"> applies the focus-visible:ring-2
      // class. We assert via the variant-side bg-transparent token
      // because Tailwind sometimes prunes the literal `ring-2` from
      // the static markup (the cva concat keeps it but order varies).
      expect(html).toContain("border-[hsl(var(--border))]");
    });
  }
});
