import { describe, it, expect } from "bun:test";

import { nextTheme } from "../../src/lib/theme";

describe("nextTheme", () => {
  it("flips dark → light", () => {
    expect(nextTheme("dark")).toBe("light");
  });

  it("flips light → dark", () => {
    expect(nextTheme("light")).toBe("dark");
  });

  it("flips system → light when resolvedTheme is dark", () => {
    expect(nextTheme("system", "dark")).toBe("light");
  });

  it("flips system → dark when resolvedTheme is light", () => {
    expect(nextTheme("system", "light")).toBe("dark");
  });

  it("falls back to dark when current is undefined (pre-hydration)", () => {
    expect(nextTheme(undefined)).toBe("dark");
  });

  it("falls back to dark when current is null", () => {
    expect(nextTheme(null)).toBe("dark");
  });

  it("falls back to dark for an unrecognised value", () => {
    expect(nextTheme("solarized")).toBe("dark");
  });

  it("treats system without resolvedTheme as dark fallback", () => {
    expect(nextTheme("system")).toBe("dark");
  });
});
