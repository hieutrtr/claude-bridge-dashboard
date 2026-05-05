import { describe, it, expect, beforeEach, afterEach } from "bun:test";

const ORIGINAL_ENV = { ...process.env };

function setEnv(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
}

async function freshModule() {
  const url = `../../src/server/rate-limit-login.ts?t=${Math.random()}`;
  return (await import(url)) as typeof import("../../src/server/rate-limit-login");
}

beforeEach(async () => {
  setEnv({ RATE_LIMIT_LOGIN_PER_MIN: undefined });
  const m = await freshModule();
  m._reset();
});

afterEach(() => {
  setEnv({ RATE_LIMIT_LOGIN_PER_MIN: ORIGINAL_ENV.RATE_LIMIT_LOGIN_PER_MIN });
});

function makeReq(xff: string | undefined): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (xff) headers["x-forwarded-for"] = xff;
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers,
    body: JSON.stringify({ password: "x" }),
  });
}

describe("rateLimitLogin", () => {
  it("allows 5 requests in a row from the same IP", async () => {
    const { rateLimitLogin } = await freshModule();
    for (let i = 0; i < 5; i++) {
      expect(await rateLimitLogin(makeReq("1.2.3.4"))).toBeNull();
    }
  });

  it("blocks the 6th request from the same IP with 429 + Retry-After", async () => {
    const { rateLimitLogin } = await freshModule();
    for (let i = 0; i < 5; i++) {
      await rateLimitLogin(makeReq("1.2.3.4"));
    }
    const res = await rateLimitLogin(makeReq("1.2.3.4"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    expect(Number(res!.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await res!.json();
    expect(body.error).toBe("rate_limited");
  });

  it("a different IP is unaffected by another IP's exhaustion", async () => {
    const { rateLimitLogin } = await freshModule();
    for (let i = 0; i < 5; i++) await rateLimitLogin(makeReq("1.1.1.1"));
    expect((await rateLimitLogin(makeReq("1.1.1.1")))!.status).toBe(429);
    for (let i = 0; i < 5; i++) {
      expect(await rateLimitLogin(makeReq("2.2.2.2"))).toBeNull();
    }
  });

  it("missing IP headers fall back to a single shared 'unknown' bucket", async () => {
    const { rateLimitLogin } = await freshModule();
    // 5 unproxied calls all pass; the 6th — also unproxied — is denied.
    for (let i = 0; i < 5; i++) {
      expect(await rateLimitLogin(makeReq(undefined))).toBeNull();
    }
    expect((await rateLimitLogin(makeReq(undefined)))!.status).toBe(429);
  });

  it("RATE_LIMIT_LOGIN_PER_MIN=0 disables the guard", async () => {
    setEnv({ RATE_LIMIT_LOGIN_PER_MIN: "0" });
    const { rateLimitLogin } = await freshModule();
    for (let i = 0; i < 100; i++) {
      expect(await rateLimitLogin(makeReq("3.3.3.3"))).toBeNull();
    }
  });
});
