// P4-T12 — Pure tests for the locale registry + cookie resolver.

import { describe, it, expect } from "bun:test";

import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_COOKIE,
  LOCALE_LABELS,
  isSupportedLocale,
  resolveLocale,
} from "../../src/i18n/locales";

describe("LOCALES registry", () => {
  it("exports en + vi in declaration order", () => {
    expect(LOCALES).toEqual(["en", "vi"]);
  });

  it("defaults to en", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("ships a label for every locale", () => {
    for (const l of LOCALES) {
      expect(LOCALE_LABELS[l]).toBeTruthy();
    }
  });

  it("uses a stable cookie name (`bridge_locale`)", () => {
    // Round-trip via document.cookie + Next middleware depends on this
    // exact spelling — pin it so a refactor surfaces in CI.
    expect(LOCALE_COOKIE).toBe("bridge_locale");
  });
});

describe("isSupportedLocale", () => {
  it("accepts each registered locale", () => {
    for (const l of LOCALES) {
      expect(isSupportedLocale(l)).toBe(true);
    }
  });

  it("rejects unknown / non-string values", () => {
    expect(isSupportedLocale("ja")).toBe(false);
    expect(isSupportedLocale("EN")).toBe(false); // case-sensitive
    expect(isSupportedLocale("")).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);
  });
});

describe("resolveLocale", () => {
  it("returns the locale unchanged when supported", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("vi")).toBe("vi");
  });

  it("normalises case", () => {
    expect(resolveLocale("EN")).toBe("en");
    expect(resolveLocale("Vi")).toBe("vi");
  });

  it("strips region tags (vi-VN, en_US)", () => {
    expect(resolveLocale("vi-VN")).toBe("vi");
    expect(resolveLocale("en_US")).toBe("en");
  });

  it("falls back to default for unknown / empty", () => {
    expect(resolveLocale("ja")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
});
