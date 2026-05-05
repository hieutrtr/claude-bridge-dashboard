import { describe, it, expect } from "bun:test";

import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken, verifyCsrfToken } from "../../src/lib/csrf";

const SECRET = "csrf-test-secret-please-do-not-use-in-prod";

describe("constants", () => {
  it("exports a stable cookie name", () => {
    expect(CSRF_COOKIE).toBe("bridge_csrf_token");
  });

  it("exports the lower-cased x-csrf-token header name", () => {
    expect(CSRF_HEADER).toBe("x-csrf-token");
  });
});

describe("issueCsrfToken / verifyCsrfToken", () => {
  it("round-trips: a freshly issued token verifies under the same secret", async () => {
    const token = await issueCsrfToken(SECRET);
    const parts = token.split(".");
    expect(parts.length).toBe(2);
    for (const segment of parts) {
      expect(/^[A-Za-z0-9_-]+$/.test(segment)).toBe(true);
    }
    expect(await verifyCsrfToken(token, SECRET)).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await issueCsrfToken(SECRET);
    expect(await verifyCsrfToken(token, "different-secret-value")).toBe(false);
  });

  it("rejects a token with a tampered random part (signature mismatch)", async () => {
    const token = await issueCsrfToken(SECRET);
    const [r, s] = token.split(".");
    const flippedChar = r[0] === "A" ? "B" : "A";
    const tampered = `${flippedChar}${r.slice(1)}.${s}`;
    expect(await verifyCsrfToken(tampered, SECRET)).toBe(false);
  });

  it("rejects a token with a tampered signature", async () => {
    const token = await issueCsrfToken(SECRET);
    const [r, s] = token.split(".");
    const flippedChar = s[0] === "A" ? "B" : "A";
    const tampered = `${r}.${flippedChar}${s.slice(1)}`;
    expect(await verifyCsrfToken(tampered, SECRET)).toBe(false);
  });

  it("rejects malformed inputs without throwing", async () => {
    for (const bad of ["", "abc", "a.b.c", "a.b.c.d", ".", "a.", ".b", "..", "a..b"]) {
      expect(await verifyCsrfToken(bad, SECRET)).toBe(false);
    }
  });

  it("issueCsrfToken throws when secret is empty", async () => {
    await expect(issueCsrfToken("")).rejects.toThrow();
  });

  it("verifyCsrfToken throws when secret is empty", async () => {
    const token = await issueCsrfToken(SECRET);
    await expect(verifyCsrfToken(token, "")).rejects.toThrow();
  });

  it("two consecutive issuances produce different tokens (entropy guard)", async () => {
    const a = await issueCsrfToken(SECRET);
    const b = await issueCsrfToken(SECRET);
    expect(a).not.toBe(b);
    // Both still verify under the secret.
    expect(await verifyCsrfToken(a, SECRET)).toBe(true);
    expect(await verifyCsrfToken(b, SECRET)).toBe(true);
  });

  it("verifyCsrfToken treats non-string inputs as invalid", async () => {
    // Cast through unknown to exercise the runtime guard rather than the type guard.
    expect(await verifyCsrfToken(undefined as unknown as string, SECRET)).toBe(false);
    expect(await verifyCsrfToken(null as unknown as string, SECRET)).toBe(false);
    expect(await verifyCsrfToken(123 as unknown as string, SECRET)).toBe(false);
  });
});
