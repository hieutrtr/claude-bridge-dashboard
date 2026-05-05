import { describe, it, expect, beforeEach, afterEach } from "bun:test";

const ORIGINAL_ENV = { ...process.env };

function setEnv(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
}

async function freshModule() {
  // Bun's loader caches ESM by URL; appending a query string yields a
  // fresh evaluation so module-init env reads pick up the test config.
  const url = `../../src/server/rate-limit-mutations.ts?t=${Math.random()}`;
  return (await import(url)) as typeof import("../../src/server/rate-limit-mutations");
}

beforeEach(async () => {
  setEnv({ RATE_LIMIT_MUTATIONS_PER_MIN: undefined });
  // Reset the shared bucket state before every test.
  const m = await freshModule();
  m._reset();
});

afterEach(() => {
  setEnv({ RATE_LIMIT_MUTATIONS_PER_MIN: ORIGINAL_ENV.RATE_LIMIT_MUTATIONS_PER_MIN });
});

function makeReq(
  method: string,
  init: { xff?: string; xRealIp?: string } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.xff) headers["x-forwarded-for"] = init.xff;
  if (init.xRealIp) headers["x-real-ip"] = init.xRealIp;
  const requestInit: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") requestInit.body = JSON.stringify({});
  return new Request("http://localhost/api/trpc/anything", requestInit);
}

describe("rateLimitMutations — exempt methods", () => {
  it("returns null for GET", async () => {
    const { rateLimitMutations } = await freshModule();
    expect(await rateLimitMutations(makeReq("GET"), null)).toBeNull();
  });

  it("returns null for HEAD/OPTIONS", async () => {
    const { rateLimitMutations } = await freshModule();
    expect(await rateLimitMutations(makeReq("HEAD"), null)).toBeNull();
    expect(await rateLimitMutations(makeReq("OPTIONS"), null)).toBeNull();
  });
});

describe("rateLimitMutations — keying", () => {
  it("keys on sessionUserId when provided (independent buckets)", async () => {
    const { rateLimitMutations } = await freshModule();
    // 30 calls for user A — all pass
    for (let i = 0; i < 30; i++) {
      expect(await rateLimitMutations(makeReq("POST"), "userA")).toBeNull();
    }
    // 31st for A — denied
    const denied = await rateLimitMutations(makeReq("POST"), "userA");
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(429);
    // 30 calls for user B — still all pass
    for (let i = 0; i < 30; i++) {
      expect(await rateLimitMutations(makeReq("POST"), "userB")).toBeNull();
    }
  });

  it("falls back to first hop of x-forwarded-for when no session", async () => {
    const { rateLimitMutations } = await freshModule();
    // Two distinct IPs each get their own bucket of 30
    for (let i = 0; i < 30; i++) {
      expect(
        await rateLimitMutations(makeReq("POST", { xff: "1.2.3.4, 10.0.0.1" }), null),
      ).toBeNull();
    }
    expect(
      (await rateLimitMutations(makeReq("POST", { xff: "1.2.3.4" }), null))!.status,
    ).toBe(429);
    expect(
      await rateLimitMutations(makeReq("POST", { xff: "5.6.7.8" }), null),
    ).toBeNull();
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    const { rateLimitMutations } = await freshModule();
    for (let i = 0; i < 30; i++) {
      expect(
        await rateLimitMutations(makeReq("POST", { xRealIp: "9.9.9.9" }), null),
      ).toBeNull();
    }
    expect(
      (await rateLimitMutations(makeReq("POST", { xRealIp: "9.9.9.9" }), null))!.status,
    ).toBe(429);
  });

  it("falls back to 'unknown' when no IP header is present", async () => {
    const { rateLimitMutations } = await freshModule();
    // We just assert the call doesn't throw — pooling unproxied calls
    // into a single bucket is a deliberate fail-safe.
    expect(await rateLimitMutations(makeReq("POST"), null)).toBeNull();
  });
});

describe("rateLimitMutations — 429 response shape", () => {
  it("returns 429 with Retry-After header and JSON body", async () => {
    const { rateLimitMutations } = await freshModule();
    for (let i = 0; i < 30; i++) {
      await rateLimitMutations(makeReq("POST"), "u");
    }
    const res = await rateLimitMutations(makeReq("POST"), "u");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    const retry = res!.headers.get("Retry-After");
    expect(retry).not.toBeNull();
    expect(Number(retry)).toBeGreaterThan(0);
    const body = await res!.json();
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfterSec).toBe("number");
    expect(body.retryAfterSec).toBeGreaterThan(0);
  });
});

describe("rateLimitMutations — disabled via env", () => {
  it("RATE_LIMIT_MUTATIONS_PER_MIN=0 disables the guard", async () => {
    setEnv({ RATE_LIMIT_MUTATIONS_PER_MIN: "0" });
    const { rateLimitMutations } = await freshModule();
    for (let i = 0; i < 1000; i++) {
      expect(await rateLimitMutations(makeReq("POST"), "u")).toBeNull();
    }
  });
});
