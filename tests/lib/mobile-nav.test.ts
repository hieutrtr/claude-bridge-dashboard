// P4-T07 — Pure-helper tests for the mobile nav drawer. Live in
// `tests/lib/` because the helpers don't touch the DOM (the
// drawer-rendering test lives in `tests/app/sheet.test.tsx`).

import { describe, it, expect } from "bun:test";

import {
  isMobileViewport,
  meetsTouchTarget,
  MIN_TOUCH_TARGET_PX,
  MOBILE_BREAKPOINT_PX,
  shouldCloseOnPathChange,
} from "../../src/lib/mobile-nav";

describe("isMobileViewport", () => {
  it("returns true under the md breakpoint (767)", () => {
    expect(isMobileViewport(360)).toBe(true);
    expect(isMobileViewport(390)).toBe(true);
    expect(isMobileViewport(MOBILE_BREAKPOINT_PX - 1)).toBe(true);
  });

  it("returns false at and above the md breakpoint (768+)", () => {
    expect(isMobileViewport(MOBILE_BREAKPOINT_PX)).toBe(false);
    expect(isMobileViewport(1024)).toBe(false);
    expect(isMobileViewport(1920)).toBe(false);
  });

  it("treats non-finite or non-positive widths as mobile (defensive)", () => {
    expect(isMobileViewport(0)).toBe(true);
    expect(isMobileViewport(-100)).toBe(true);
    expect(isMobileViewport(Number.NaN)).toBe(true);
    // Infinity is non-finite → falls through to the defensive "mobile"
    // default. Better to render the drawer than ship a UI that hides
    // the nav for an unparseable width.
    expect(isMobileViewport(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe("shouldCloseOnPathChange", () => {
  it("closes the drawer when the path changes while open", () => {
    expect(shouldCloseOnPathChange("/agents", "/tasks", true)).toBe(true);
    expect(shouldCloseOnPathChange("/", "/agents", true)).toBe(true);
  });

  it("does not close when the path is the same", () => {
    expect(shouldCloseOnPathChange("/agents", "/agents", true)).toBe(false);
  });

  it("does not close when the drawer is already closed", () => {
    expect(shouldCloseOnPathChange("/agents", "/tasks", false)).toBe(false);
  });

  it("does not close on initial render (previous path is null)", () => {
    expect(shouldCloseOnPathChange(null, "/agents", true)).toBe(false);
    expect(shouldCloseOnPathChange("/agents", null, true)).toBe(false);
  });
});

describe("meetsTouchTarget", () => {
  it("accepts h-11 and h-12 (44px / 48px)", () => {
    expect(meetsTouchTarget("h-11")).toBe(true);
    expect(meetsTouchTarget("h-12")).toBe(true);
    expect(meetsTouchTarget("h-14")).toBe(true);
  });

  it("rejects h-9 and h-10 (36px / 40px)", () => {
    expect(meetsTouchTarget("h-9")).toBe(false);
    expect(meetsTouchTarget("h-10")).toBe(false);
    expect(meetsTouchTarget("h-8")).toBe(false);
  });

  it("opts out for h-auto (caller verifies content height)", () => {
    expect(meetsTouchTarget("h-auto")).toBe(true);
  });

  it("rejects garbage utility strings", () => {
    expect(meetsTouchTarget("h-")).toBe(false);
    expect(meetsTouchTarget("text-sm")).toBe(false);
    expect(meetsTouchTarget("")).toBe(false);
  });

  it("MIN_TOUCH_TARGET_PX is 44 (WCAG 2.5.5 AAA / Apple HIG)", () => {
    expect(MIN_TOUCH_TARGET_PX).toBe(44);
  });
});
