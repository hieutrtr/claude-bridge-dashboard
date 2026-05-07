// P4-T07 — Static-markup tests for the responsive app shell. We assert
// the utility classes that drive the breakpoint behaviour because the
// shell isn't covered by an interactive Playwright spec on every PR.
//
// Why this matters: the desktop sidebar must NOT render below `md`
// (it would push the main column off-screen on a 390px iPhone), and
// the mobile-nav trigger must NOT render at and above `md` (it would
// double up with the sidebar). The hamburger trigger must hold a 44×44
// touch target. The topbar must be sticky so it survives long scroll.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Sidebar } from "../../src/components/sidebar";
import { Topbar } from "../../src/components/topbar";

describe("<Sidebar> responsive utilities", () => {
  it("hides on mobile and shows from md+ (`hidden md:flex`)", () => {
    const html = renderToStaticMarkup(<Sidebar />);
    // Tailwind class breakdown — must contain BOTH the hidden default
    // and the md:flex breakpoint variant. Searching for the literal
    // substrings keeps the test resilient to other utility ordering.
    expect(html).toContain("hidden");
    expect(html).toContain("md:flex");
    expect(html).toContain('data-role="desktop-sidebar"');
  });

  it("nav links carry a 44px touch target on mobile (`h-11`)", () => {
    const html = renderToStaticMarkup(<Sidebar />);
    // Each NAV_ITEMS entry renders an <a>; the className contains
    // `h-11` (mobile) and `md:h-9` (desktop compresses).
    expect(html).toContain("h-11");
    expect(html).toContain("md:h-9");
  });
});

describe("<Topbar> responsive utilities", () => {
  it("renders a sticky header (top-0) above z-30", () => {
    const html = renderToStaticMarkup(<Topbar />);
    expect(html).toContain("sticky");
    expect(html).toContain("top-0");
    expect(html).toContain("z-30");
  });

  it("renders the mobile-nav trigger with md:hidden", () => {
    const html = renderToStaticMarkup(<Topbar />);
    expect(html).toContain('data-role="mobile-nav-trigger"');
    // Trigger button is hidden from md+ so it doesn't double-up with
    // the visible desktop sidebar.
    expect(html).toMatch(/data-role="mobile-nav-trigger"[^>]*md:hidden/);
  });

  it("mobile-nav trigger meets 44×44 touch target (h-11 w-11)", () => {
    const html = renderToStaticMarkup(<Topbar />);
    // The trigger element carries both h-11 and w-11 utilities; the
    // regex tolerates any ordering of other utilities between them.
    expect(html).toMatch(/data-role="mobile-nav-trigger"[^>]*h-11[^>]*w-11|data-role="mobile-nav-trigger"[^>]*w-11[^>]*h-11/);
  });

  it("user menu placeholder is hidden below sm (saves header width)", () => {
    const html = renderToStaticMarkup(<Topbar />);
    // P4-T10 — the placeholder is decorative; aria-label was dropped
    // to satisfy axe-core's `aria-prohibited-attr` rule (no role on
    // a <div>). We assert the visual contract via the rounded-full
    // disc class + the responsive `hidden sm:block` toggle, plus
    // `aria-hidden="true"` so screen readers skip it.
    const placeholderTag = html.match(
      /<div aria-hidden="true" class="[^"]*"\s*\/?>(?:<\/div>)?/,
    );
    expect(placeholderTag, "expected an aria-hidden placeholder <div>").not.toBeNull();
    const tag = placeholderTag![0];
    expect(tag).toContain("rounded-full");
    expect(tag).toContain("hidden");
    expect(tag).toContain("sm:block");
  });
});
