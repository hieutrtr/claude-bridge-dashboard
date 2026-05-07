// P4-T07 — Static-markup tests for `<Sheet>` and the rendered mobile
// nav drawer panel. Uses the same `renderToStaticMarkup` pattern the
// rest of `tests/app/` follows so we don't need a JSDOM in unit tests.
//
// Interactive contracts (focus trap, ESC, body-scroll lock) are verified
// by Playwright in the Phase 4 step 15 sweep.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Sheet } from "../../src/components/ui/sheet";

describe("<Sheet> closed", () => {
  it("renders nothing observable when open=false", () => {
    const html = renderToStaticMarkup(
      <Sheet
        open={false}
        onOpenChange={() => {}}
        ariaLabel="Test menu"
      >
        <div>panel children</div>
      </Sheet>,
    );
    expect(html).toBe("");
  });
});

describe("<Sheet> open", () => {
  function open(opts?: { side?: "left" | "right"; ariaLabelledBy?: string }) {
    return renderToStaticMarkup(
      <Sheet
        open
        onOpenChange={() => {}}
        ariaLabel="Test menu"
        side={opts?.side}
        ariaLabelledBy={opts?.ariaLabelledBy}
        dataRole="test-sheet"
      >
        <a href="/x">link x</a>
        <button type="button">btn</button>
      </Sheet>,
    );
  }

  it("renders the dialog shell with role + aria-modal", () => {
    const html = open();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-role="test-sheet"');
  });

  it("uses ariaLabelledBy when provided, ariaLabel otherwise", () => {
    const labelled = open({ ariaLabelledBy: "external-title" });
    expect(labelled).toContain('aria-labelledby="external-title"');
    expect(labelled).not.toContain('aria-label="Test menu"');

    const labeled = open();
    // When no labelledBy is provided, an aria-labelledby pointing at a
    // hidden internal title is rendered (so SR users get a name) AND
    // the panel still carries the visible title via aria-label.
    expect(labeled).toContain('aria-label="Test menu"');
  });

  it("anchors the panel to the requested side", () => {
    const left = open({ side: "left" });
    expect(left).toContain('data-side="left"');
    expect(left).toContain("border-r");

    const right = open({ side: "right" });
    expect(right).toContain('data-side="right"');
    expect(right).toContain("border-l");
    expect(right).toContain("ml-auto");
  });

  it("renders a close button with 44×44 touch target + accessible label", () => {
    const html = open();
    expect(html).toContain('data-role="sheet-close"');
    expect(html).toContain('aria-label="Close menu"');
    // Close button is square 44×44 (h-11 w-11).
    expect(html).toMatch(/h-11[^"]*w-11/);
  });

  it("renders a click-to-close backdrop", () => {
    const html = open();
    expect(html).toContain('data-role="sheet-backdrop"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("forwards children into the scroll panel", () => {
    const html = open();
    expect(html).toContain('href="/x"');
    expect(html).toContain(">btn<");
  });
});
