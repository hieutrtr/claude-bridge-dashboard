import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { POST, GET } from "../../app/api/trpc/[trpc]/route";
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from "../../src/lib/csrf";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "trpc-csrf-route-test-secret-please-do-not-use-in-prod";

function setEnv(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  setEnv({ JWT_SECRET: SECRET });
});

afterEach(() => {
  setEnv({ JWT_SECRET: ORIGINAL_ENV.JWT_SECRET });
});

// Phase 2 has no mutation procedures yet (those land in T01..T06). The
// CSRF guard must still be in place at the tRPC HTTP entry — exercised
// by aiming a POST at the path of any procedure: the guard returns 403
// before the tRPC router has a chance to dispatch.

describe("POST /api/trpc/* CSRF guard", () => {
  it("rejects POST without CSRF cookie/header (403)", async () => {
    const req = new Request("http://localhost/api/trpc/agents.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "csrf_invalid" });
  });

  it("rejects POST with mismatched cookie/header (403)", async () => {
    const a = await issueCsrfToken(SECRET);
    const b = await issueCsrfToken(SECRET);
    const req = new Request("http://localhost/api/trpc/agents.list", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${CSRF_COOKIE}=${a}`,
        [CSRF_HEADER]: b,
      },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 503 when JWT_SECRET is unset (fail closed)", async () => {
    setEnv({ JWT_SECRET: undefined });
    const req = new Request("http://localhost/api/trpc/agents.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it("passes through to the tRPC handler when CSRF is valid", async () => {
    const token = await issueCsrfToken(SECRET);
    // We don't need a real DB row here — we just need to assert the
    // request reached the tRPC layer (i.e. it was NOT a 403 from the
    // guard). The handler's own validation may produce its own status.
    const req = new Request("http://localhost/api/trpc/agents.list", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${CSRF_COOKIE}=${token}`,
        [CSRF_HEADER]: token,
      },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
  });
});

describe("GET /api/trpc/* CSRF guard exemption", () => {
  it("does not enforce CSRF on GET (queries pass through)", async () => {
    const req = new Request("http://localhost/api/trpc/agents.list", {
      method: "GET",
    });
    const res = await GET(req);
    // Whatever the tRPC handler returns, the CSRF guard must not have
    // produced a 403 for a GET request.
    expect(res.status).not.toBe(403);
  });
});
