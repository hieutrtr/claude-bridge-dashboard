import { describe, it, expect } from "bun:test";

import { NAV_ITEMS, isNavActive } from "../../src/lib/nav";

describe("NAV_ITEMS", () => {
  it("exports exactly 5 items in plan-defined order", () => {
    expect(NAV_ITEMS.length).toBe(5);
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Agents",
      "Tasks",
      "Loops",
      "Schedules",
      "Cost",
    ]);
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      "/agents",
      "/tasks",
      "/loops",
      "/schedules",
      "/cost",
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
