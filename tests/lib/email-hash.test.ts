import { describe, it, expect } from "bun:test";

import {
  emailHash,
  normalizeEmail,
  resolveAuditSalt,
} from "../../src/lib/email-hash";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Hieu@Example.COM ")).toBe("hieu@example.com");
  });

  it("is idempotent", () => {
    const once = normalizeEmail("Hieu@Example.com");
    expect(normalizeEmail(once)).toBe(once);
  });
});

describe("emailHash", () => {
  it("is deterministic for a given (email, salt) pair", () => {
    expect(emailHash("a@b.com", "salt")).toBe(emailHash("a@b.com", "salt"));
  });

  it("is case-insensitive on the email", () => {
    expect(emailHash("A@B.com", "salt")).toBe(emailHash("a@b.com", "salt"));
  });

  it("differs for the same email under different salts", () => {
    expect(emailHash("a@b.com", "salt-one")).not.toBe(
      emailHash("a@b.com", "salt-two"),
    );
  });

  it("returns a base64url string of fixed length (43 chars)", () => {
    const h = emailHash("a@b.com", "salt");
    expect(/^[A-Za-z0-9_-]+$/.test(h)).toBe(true);
    expect(h.length).toBe(43);
  });

  it("throws when salt is empty (would produce a privacy regression)", () => {
    expect(() => emailHash("a@b.com", "")).toThrow();
  });

  it("does not contain the email plaintext", () => {
    const h = emailHash("hieu@example.com", "any-salt");
    expect(h.includes("hieu")).toBe(false);
    expect(h.includes("example")).toBe(false);
  });
});

describe("resolveAuditSalt", () => {
  it("prefers AUDIT_IP_HASH_SALT", () => {
    expect(
      resolveAuditSalt({ AUDIT_IP_HASH_SALT: "x", JWT_SECRET: "y" }),
    ).toBe("x");
  });

  it("falls back to JWT_SECRET", () => {
    expect(resolveAuditSalt({ JWT_SECRET: "y" })).toBe("y");
  });

  it("returns null when neither is set", () => {
    expect(resolveAuditSalt({})).toBeNull();
  });

  it("treats empty string as missing", () => {
    expect(
      resolveAuditSalt({ AUDIT_IP_HASH_SALT: "", JWT_SECRET: "" }),
    ).toBeNull();
  });
});
