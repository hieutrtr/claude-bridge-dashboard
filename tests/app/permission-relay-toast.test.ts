// P2-T09 — `<PermissionRelayToastView>` view-only markup tests.
// Render with `renderToStaticMarkup` to assert the rendered HTML
// across the toast state matrix without standing up jsdom.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PermissionRelayToastView,
  type PermissionToastItem,
} from "../../src/components/permission-relay-toast";

function pendingItem(
  id: string,
  overrides: Partial<PermissionToastItem> = {},
): PermissionToastItem {
  return {
    id,
    sessionId: "sess-1",
    toolName: "Bash",
    command: "ls /tmp",
    description: null,
    status: "idle",
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function render(props: Parameters<typeof PermissionRelayToastView>[0]): string {
  return renderToStaticMarkup(PermissionRelayToastView(props));
}

describe("PermissionRelayToastView", () => {
  it("renders nothing observable when items is empty", () => {
    const html = render({ items: [], csrfMissing: false });
    expect(html).toBe("");
  });

  it("renders one row with tool, command, Allow, and Deny", () => {
    const html = render({
      items: [pendingItem("perm-1")],
      csrfMissing: false,
    });
    expect(html).toContain("Bash");
    expect(html).toContain("ls /tmp");
    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
    expect(html).toContain("perm-1");
  });

  it("renders multiple items as a stack", () => {
    const html = render({
      items: [
        pendingItem("perm-a", { toolName: "Bash", command: "ls" }),
        pendingItem("perm-b", { toolName: "Edit", command: "vim foo.ts" }),
      ],
      csrfMissing: false,
    });
    expect(html).toContain("perm-a");
    expect(html).toContain("perm-b");
    expect(html).toContain("Edit");
    expect(html).toContain("vim foo.ts");
  });

  it("disables both buttons and shows hint when csrfMissing=true", () => {
    const html = render({
      items: [pendingItem("perm-1")],
      csrfMissing: true,
    });
    // Two disabled buttons (Allow + Deny) → at least 2 disabled attrs.
    const disabledMatches = html.match(/disabled=""/g) ?? [];
    expect(disabledMatches.length).toBeGreaterThanOrEqual(2);
    expect(html.toLowerCase()).toContain("session");
  });

  it("disables only the submitting item's buttons", () => {
    const html = render({
      items: [
        pendingItem("perm-a", { status: "submitting" }),
        pendingItem("perm-b", { status: "idle" }),
      ],
      csrfMissing: false,
    });
    // Each row has 2 buttons → 4 buttons total. Only 2 should be
    // disabled (the submitting row).
    const disabledMatches = html.match(/disabled=""/g) ?? [];
    expect(disabledMatches.length).toBe(2);
  });

  it("renders the per-item error code + message and re-enables buttons", () => {
    const html = render({
      items: [
        pendingItem("perm-1", {
          status: "error",
          errorCode: "TIMEOUT",
          errorMessage: "Daemon did not respond",
        }),
      ],
      csrfMissing: false,
    });
    expect(html).toContain("TIMEOUT");
    expect(html).toContain("Daemon did not respond");
    // Buttons re-enabled (no `disabled=""`).
    expect(html).not.toMatch(/disabled=""/);
  });

  it("truncates long commands with an ellipsis", () => {
    const longCmd = "x".repeat(500);
    const html = render({
      items: [pendingItem("perm-1", { command: longCmd })],
      csrfMissing: false,
    });
    // The truncated string is shorter than the input + has an ellipsis.
    expect(html).toContain("…");
    expect(html).not.toContain("x".repeat(500));
  });

  it("renders the description below the command when present", () => {
    const html = render({
      items: [
        pendingItem("perm-1", {
          description: "remove tmp dir",
          command: "rm -rf /tmp/work",
        }),
      ],
      csrfMissing: false,
    });
    expect(html).toContain("remove tmp dir");
  });

  it("handles a null command gracefully (renders the tool only)", () => {
    const html = render({
      items: [pendingItem("perm-1", { command: null })],
      csrfMissing: false,
    });
    expect(html).toContain("Bash");
    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
  });
});
