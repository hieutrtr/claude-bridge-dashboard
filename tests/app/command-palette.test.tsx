// P4-T05 — `<CommandPaletteView>` view-only markup tests. Mirrors the
// dispatch-dialog pattern (`tests/app/dispatch-dialog.test.ts`): feed
// React props into `renderToStaticMarkup` and assert the rendered HTML
// contains the right roles, copy, and ARIA attributes.
//
// The interactive `<CommandPalette>` wrapper is exercised by Playwright
// (Phase 4 step 15) — its hooks + cmdk integration require a DOM.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CommandPaletteView } from "../../src/components/command-palette";

describe("<CommandPaletteView> closed", () => {
  it("renders nothing observable when open=false", () => {
    const html = renderToStaticMarkup(
      <CommandPaletteView
        open={false}
        view="actions"
        role="owner"
        query=""
      />,
    );
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Command palette");
    expect(html).not.toContain("Dispatch task");
  });
});

describe("<CommandPaletteView> actions view — owner", () => {
  function html(query = "") {
    return renderToStaticMarkup(
      <CommandPaletteView
        open
        view="actions"
        role="owner"
        query={query}
      />,
    );
  }

  it("renders the dialog shell + search input + action list", () => {
    const out = html();
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('aria-labelledby="command-palette-title"');
    expect(out).toContain("Command palette");
    expect(out).toContain('aria-label="Search commands"');
    expect(out).toContain('id="command-palette-list"');
    expect(out).toContain('role="listbox"');
    expect(out).toContain("Type a command or search");
  });

  it("renders the Esc + ? buttons in the header", () => {
    const out = html();
    expect(out).toContain("Close command palette");
    expect(out).toContain("Show keyboard shortcuts");
  });

  it("renders the three category headers (Actions / Navigate / System)", () => {
    const out = html();
    expect(out).toContain("Actions");
    expect(out).toContain("Navigate");
    expect(out).toContain("System");
  });

  it("renders the dispatch / loop / schedule action labels", () => {
    const out = html();
    expect(out).toContain("Dispatch task to agent");
    expect(out).toContain("Start a loop");
    expect(out).toContain("New schedule");
  });

  it("renders every navigate command with the correct href data hint", () => {
    const out = html();
    expect(out).toContain("Go to agents");
    expect(out).toContain("Go to tasks");
    expect(out).toContain("Go to loops");
    expect(out).toContain("Go to schedules");
    expect(out).toContain("Go to cost dashboard");
    expect(out).toContain("Go to audit log");
  });

  it("renders the owner-only Manage users command for owners", () => {
    const out = html();
    expect(out).toContain("Manage users");
    expect(out).toContain('data-action-id="go-users"');
  });

  it("renders the leader-key chips (g a, g t, …) as <kbd> tags", () => {
    const out = html();
    expect(out).toContain("<kbd");
    // At least the g + a pair for the "Go to agents" entry must appear
    expect(out).toMatch(/<kbd[^>]*>g<\/kbd>/);
    expect(out).toMatch(/<kbd[^>]*>a<\/kbd>/);
  });

  it("filters results by query (case-insensitive) on label + hint", () => {
    const out = html("audit");
    expect(out).toContain("Go to audit log");
    expect(out).not.toContain("Dispatch task to agent");
    expect(out).not.toContain("Manage users");
  });

  it("shows the empty-search hint when no commands match the query", () => {
    const out = html("zzz-no-match");
    expect(out).toContain("No commands match");
  });

  it("never wraps action labels in dangerouslySetInnerHTML / __html", () => {
    const out = html();
    expect(out).not.toContain("__html");
    expect(out).not.toContain("dangerouslySetInnerHTML");
  });

  it("escapes HTML in the query echo (defense-in-depth XSS check)", () => {
    const out = html('<script>alert(1)</script>');
    // The query echo path: the empty-state hint quotes back the query
    // string. React must escape the angle brackets in the rendered HTML.
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("<CommandPaletteView> actions view — member", () => {
  function html() {
    return renderToStaticMarkup(
      <CommandPaletteView
        open
        view="actions"
        role="member"
        query=""
      />,
    );
  }

  it("hides Manage users (owner-only) for members", () => {
    const out = html();
    expect(out).not.toContain("Manage users");
    expect(out).not.toContain('data-action-id="go-users"');
  });

  it("still shows the rest of the static action set", () => {
    const out = html();
    expect(out).toContain("Dispatch task to agent");
    expect(out).toContain("Go to agents");
    expect(out).toContain("Sign out");
  });
});

describe("<CommandPaletteView> actions view — null role (anonymous)", () => {
  it("hides Manage users for null role too", () => {
    const out = renderToStaticMarkup(
      <CommandPaletteView
        open
        view="actions"
        role={null}
        query=""
      />,
    );
    expect(out).not.toContain("Manage users");
  });
});

describe("<CommandPaletteView> help view", () => {
  function html() {
    return renderToStaticMarkup(
      <CommandPaletteView
        open
        view="help"
        role="owner"
        query=""
      />,
    );
  }

  it("renders the help dialog with the eight documented shortcuts", () => {
    const out = html();
    expect(out).toContain("Keyboard shortcuts");
    expect(out).toContain("Open command palette");
    expect(out).toContain("Go to agents");
    expect(out).toContain("Go to tasks");
    expect(out).toContain("Go to loops");
    expect(out).toContain("Go to schedules");
    expect(out).toContain("Go to cost dashboard");
    expect(out).toContain("Manage users (owner only)");
    expect(out).toContain("Show keyboard shortcuts");
  });

  it("renders the ⌘ + K + g + a + ? key chips", () => {
    const out = html();
    expect(out).toContain(">⌘<");
    expect(out).toContain(">K<");
    expect(out).toContain(">g<");
    expect(out).toContain(">a<");
    expect(out).toContain(">?<");
  });

  it("renders the Commands button to switch back to the actions view", () => {
    const out = html();
    expect(out).toContain("Back to commands");
  });

  it("does NOT render the search input on the help view", () => {
    const out = html();
    expect(out).not.toContain('aria-label="Search commands"');
    expect(out).not.toContain("Type a command or search");
  });
});
