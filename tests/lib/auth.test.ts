import { describe, it, expect } from "bun:test";

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
  verifySession,
  timingSafeEqual,
  readAuthEnv,
} from "../../src/lib/auth";

const SECRET = "test-secret-please-do-not-use-in-prod";

describe("constants", () => {
  it("exports a stable cookie name", () => {
    expect(SESSION_COOKIE).toBe("bridge_dashboard_session");
  });

  it("session TTL is 7 days in seconds", () => {
    expect(SESSION_TTL_SECONDS).toBe(60 * 60 * 24 * 7);
  });
});

describe("signSession / verifySession", () => {
  it("round-trips and yields the expected claims", async () => {
    const now = 1_700_000_000; // arbitrary fixed epoch second
    const token = await signSession(SECRET, now);
    const parts = token.split(".");
    expect(parts.length).toBe(3);
    for (const segment of parts) {
      // base64url alphabet only, no padding
      expect(/^[A-Za-z0-9_-]+$/.test(segment)).toBe(true);
    }
    const payload = await verifySession(token, SECRET, now + 1);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("owner");
    expect(payload!.iat).toBe(now);
    expect(payload!.exp).toBe(now + SESSION_TTL_SECONDS);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession(SECRET, 1_700_000_000);
    expect(await verifySession(token, "different-secret", 1_700_000_000)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await signSession(SECRET, 1_700_000_000);
    const [h, p, s] = token.split(".");
    // flip a single character in the payload segment
    const tamperedChar = p[0] === "A" ? "B" : "A";
    const tampered = `${h}.${tamperedChar}${p.slice(1)}.${s}`;
    expect(await verifySession(tampered, SECRET, 1_700_000_000)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "...", "a..c"]) {
      expect(await verifySession(bad, SECRET, 1_700_000_000)).toBeNull();
    }
  });

  it("rejects an expired token", async () => {
    const iat = 1_700_000_000;
    const token = await signSession(SECRET, iat);
    const past = iat + SESSION_TTL_SECONDS + 1;
    expect(await verifySession(token, SECRET, past)).toBeNull();
  });

  it("refuses to sign or verify when secret is empty", async () => {
    await expect(signSession("", 1_700_000_000)).rejects.toThrow();
    const token = await signSession(SECRET, 1_700_000_000);
    await expect(verifySession(token, "", 1_700_000_000)).rejects.toThrow();
  });
});

describe("timingSafeEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("hunter2", "hunter2")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqual("abcdefg", "abcdxyz")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    expect(timingSafeEqual("short", "longer-string")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("readAuthEnv", () => {
  it("returns both values when env is fully populated", () => {
    const env = { DASHBOARD_PASSWORD: "letmein", JWT_SECRET: "supersecret" };
    expect(readAuthEnv(env)).toEqual({
      password: "letmein",
      secret: "supersecret",
    });
  });

  it("returns null password when DASHBOARD_PASSWORD missing", () => {
    expect(readAuthEnv({ JWT_SECRET: "s" })).toEqual({
      password: null,
      secret: "s",
    });
  });

  it("returns null secret when JWT_SECRET missing", () => {
    expect(readAuthEnv({ DASHBOARD_PASSWORD: "p" })).toEqual({
      password: "p",
      secret: null,
    });
  });

  it("treats empty strings as missing", () => {
    expect(readAuthEnv({ DASHBOARD_PASSWORD: "", JWT_SECRET: "" })).toEqual({
      password: null,
      secret: null,
    });
  });
});
