import { describe, it, expect } from "bun:test";

import {
  MAGIC_LINK_TTL_SECONDS,
  generateMagicLinkToken,
  hashMagicLinkToken,
} from "../../src/lib/magic-link-token";

describe("generateMagicLinkToken", () => {
  it("returns a URL-safe base64 string ≥ 32 characters", () => {
    const token = generateMagicLinkToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
  });

  it("is unique across many invocations (collision probability ≈ 0)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const t = generateMagicLinkToken();
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
    expect(seen.size).toBe(1000);
  });

  it("encodes 32 bytes (43 base64url chars without padding)", () => {
    // 32 bytes = 256 bits = 43 base64 chars rounded up. base64url
    // strips padding so the unpadded length is exactly 43.
    expect(generateMagicLinkToken().length).toBe(43);
  });
});

describe("hashMagicLinkToken", () => {
  it("is deterministic for a given input", () => {
    const t = "abc-DEF-123_xyz";
    expect(hashMagicLinkToken(t)).toBe(hashMagicLinkToken(t));
  });

  it("is sensitive to a single-character change", () => {
    const a = hashMagicLinkToken("hello");
    const b = hashMagicLinkToken("Hello");
    expect(a).not.toBe(b);
  });

  it("returns a base64url string of expected length (43 chars)", () => {
    const h = hashMagicLinkToken("anything");
    expect(/^[A-Za-z0-9_-]+$/.test(h)).toBe(true);
    expect(h.length).toBe(43);
  });

  it("hashing the empty string still produces a 43-char base64url digest", () => {
    expect(hashMagicLinkToken("").length).toBe(43);
  });
});

describe("MAGIC_LINK_TTL_SECONDS", () => {
  it("is exactly 15 minutes (per ARCHITECTURE §6)", () => {
    expect(MAGIC_LINK_TTL_SECONDS).toBe(15 * 60);
  });

  it("does not exceed 15 minutes (security ceiling)", () => {
    expect(MAGIC_LINK_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });
});
