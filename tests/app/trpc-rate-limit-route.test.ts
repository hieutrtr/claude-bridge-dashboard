import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { POST, GET } from "../../app/api/trpc/[trpc]/route";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
} from "../../src/lib/auth";
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from "../../src/lib/csrf";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "trpc-rate-limit-test-secret-please-do-not-use-in-prod";
void SESSION_TTL_SECONDS;

function setEnv(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
}

beforeEach(async () => {
  setEnv({ JWT_SECRET: SECRET, RATE_LIMIT_MUTATIONS_PER_MIN: undefined });
  // Reset the singleton bucket — exercises the global cache used by the
  // tRPC route's wire-up.
  const m = await import("../../src/server/rate-limit-mutations");
  m._reset();
});

afterEach(() => {
  setEnv({
    JWT_SECRET: ORIGINAL_ENV.JWT_SECRET,
    RATE_LIMIT_MUTATIONS_PER_MIN: ORIGINAL_ENV.RATE_LIMIT_MUTATIONS_PER_MIN,
  });
});

async function authedPost(): Promise<Request> {
  const csrf = await issueCsrfToken(SECRET);
  const session = await signSession(SECRET);
  return new Request("http://localhost/api/trpc/agents.list", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`,
      [CSRF_HEADER]: csrf,
    },
    body: JSON.stringify({}),
  });
}

describe("tRPC POST rate-limit (T07)", () => {
  it("permits the first 30 mutations in a minute", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await POST(await authedPost());
      // The router itself may produce non-200 (db missing fields etc.)
      // but the rate-limit guard should NEVER be the cause.
      expect(res.status).not.toBe(429);
    }
  });

  it("rejects the 31st with 429 + JSON body + Retry-After", async () => {
    for (let i = 0; i < 30; i++) {
      await POST(await authedPost());
    }
    const res = await POST(await authedPost());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfterSec).toBe("number");
  });

  it("CSRF takes precedence over rate-limit (no CSRF → 403, regardless of bucket)", async () => {
    // Exhaust the bucket first
    for (let i = 0; i < 30; i++) await POST(await authedPost());
    // No CSRF — must get 403, not 429.
    const req = new Request("http://localhost/api/trpc/agents.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("GET queries are not rate-limited", async () => {
    for (let i = 0; i < 100; i++) {
      const req = new Request("http://localhost/api/trpc/agents.list", {
        method: "GET",
      });
      const res = await GET(req);
      expect(res.status).not.toBe(429);
    }
  });
});
