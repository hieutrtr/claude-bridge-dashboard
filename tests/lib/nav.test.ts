import { describe, it, expect } from "bun:test";

import { NAV_ITEMS, isNavActive } from "../../src/lib/nav";

describe("NAV_ITEMS", () => {
  // Phase 2 T05 added the Audit entry after Cost.
  // Phase 4 T02 added the Users entry at the end (owner-only page;
  // members see a forbidden banner — link is still rendered for
  // discoverability).
  // Phase 4 T06 added the Notifications entry (self-only page;
  // every authenticated caller has their own preferences row).
  it("exports exactly 8 items in plan-defined order", () => {
    expect(NAV_ITEMS.length).toBe(8);
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Agents",
      "Tasks",
      "Loops",
      "Schedules",
      "Cost",
      "Audit",
      "Users",
      "Notifications",
    ]);
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      "/agents",
      "/tasks",
      "/loops",
      "/schedules",
      "/cost",
      "/audit",
      "/settings/users",
      "/settings/notifications",
    ]);
  });
});

describe("isNavActive", () => {
  it("matches exact path", () => {
    expect(isNavActive("/agents", "/agents")).toBe(true);
    expect(isNavActive("/cost", "/cost")).toBe(true);
  });

  it("matches sub-path of href", () => {
    expect(isNavActive("/agents/foo", "/agents")).toBe(true);
    expect(isNavActive("/agents/foo/bar", "/agents")).toBe(true);
    expect(isNavActive("/tasks/123", "/tasks")).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(isNavActive("/tasks", "/agents")).toBe(false);
    expect(isNavActive("/cost", "/loops")).toBe(false);
    expect(isNavActive("/", "/agents")).toBe(false);
  });

  it("does not match prefix-only-by-name (boundary check)", () => {
    expect(isNavActive("/agents-foo", "/agents")).toBe(false);
    expect(isNavActive("/agentsx", "/agents")).toBe(false);
  });

  it("treats trailing slash as same path", () => {
    expect(isNavActive("/agents/", "/agents")).toBe(true);
  });
});
