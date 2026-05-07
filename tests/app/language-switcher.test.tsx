// P4-T12 — Static-markup test for the language switcher view. Pure
// props in / JSX out, mirroring the <ThemeToggleView> + <CommandPalette
// View> pattern. Doesn't require a router or provider.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LanguageSwitcherView } from "../../src/components/language-switcher";

describe("<LanguageSwitcherView>", () => {
  const noop = () => {};

  it("renders the active locale as the selected option (en)", () => {
    const html = renderToStaticMarkup(
      <LanguageSwitcherView
        locale="en"
        ariaLabel="Language"
        onChange={noop}
      />,
    );
    expect(html).toContain('data-locale-current="en"');
    // SSR-rendered <select> uses `selected` on the chosen <option>
    // when the parent's `value` prop is set.
    expect(html).toMatch(/<option[^>]*value="en"[^>]*selected/);
  });

  it("renders the active locale as the selected option (vi)", () => {
    const html = renderToStaticMarkup(
      <LanguageSwitcherView
        locale="vi"
        ariaLabel="Ngôn ngữ"
        onChange={noop}
      />,
    );
    expect(html).toContain('data-locale-current="vi"');
    expect(html).toMatch(/<option[^>]*value="vi"[^>]*selected/);
  });

  it("offers all registered locales (en, vi)", () => {
    const html = renderToStaticMarkup(
      <LanguageSwitcherView
        locale="en"
        ariaLabel="Language"
        onChange={noop}
      />,
    );
    expect(html).toContain('value="en"');
    expect(html).toContain('value="vi"');
    expect(html).toContain("English");
    expect(html).toContain("Tiếng Việt");
  });

  it("carries an aria-label on the <select>", () => {
    const html = renderToStaticMarkup(
      <LanguageSwitcherView
        locale="en"
        ariaLabel="Language"
        onChange={noop}
      />,
    );
    expect(html).toContain('aria-label="Language"');
  });

  it("sizes for a 44×44 touch target on mobile (h-11) and h-9 on desktop", () => {
    const html = renderToStaticMarkup(
      <LanguageSwitcherView
        locale="en"
        ariaLabel="Language"
        onChange={noop}
      />,
    );
    expect(html).toContain("h-11");
    expect(html).toContain("sm:h-9");
  });
});
