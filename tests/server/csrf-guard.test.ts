import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from "../../src/lib/csrf";
import { csrfGuard } from "../../src/server/csrf-guard";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "csrf-guard-test-secret-please-do-not-use-in-prod";

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

function makeReq(
  method: string,
  init: { cookieToken?: string; headerToken?: string } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.cookieToken !== undefined) {
    headers["cookie"] = `${CSRF_COOKIE}=${init.cookieToken}`;
  }
  if (init.headerToken !== undefined) {
    headers[CSRF_HEADER] = init.headerToken;
  }
  const requestInit: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    requestInit.body = JSON.stringify({});
  }
  return new Request("http://localhost/api/trpc/anything", requestInit);
}

describe("csrfGuard — exempt methods", () => {
  it("returns null for GET", async () => {
    expect(await csrfGuard(makeReq("GET"))).toBeNull();
  });

  it("returns null for HEAD", async () => {
    expect(await csrfGuard(makeReq("HEAD"))).toBeNull();
  });

  it("returns null for OPTIONS", async () => {
    expect(await csrfGuard(makeReq("OPTIONS"))).toBeNull();
  });
});

describe("csrfGuard — state-changing methods", () => {
  it("returns 403 on POST without cookie or header", async () => {
    const res = await csrfGuard(makeReq("POST"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(await res!.json()).toEqual({ error: "csrf_invalid" });
  });

  it("returns 403 on POST with cookie but no header", async () => {
    const token = await issueCsrfToken(SECRET);
    const res = await csrfGuard(makeReq("POST", { cookieToken: token }));
    expect(res!.status).toBe(403);
  });

  it("returns 403 on POST with header but no cookie", async () => {
    const token = await issueCsrfToken(SECRET);
    const res = await csrfGuard(makeReq("POST", { headerToken: token }));
    expect(res!.status).toBe(403);
  });

  it("returns 403 on POST when header does not match cookie", async () => {
    const a = await issueCsrfToken(SECRET);
    const b = await issueCsrfToken(SECRET);
    expect(a).not.toBe(b);
    const res = await csrfGuard(makeReq("POST", { cookieToken: a, headerToken: b }));
    expect(res!.status).toBe(403);
  });

  it("returns 403 when matching cookie+header is signed with a different secret", async () => {
    const fromOtherDomain = await issueCsrfToken("a-completely-different-secret");
    const res = await csrfGuard(
      makeReq("POST", { cookieToken: fromOtherDomain, headerToken: fromOtherDomain }),
    );
    expect(res!.status).toBe(403);
  });

  it("returns null on POST with a valid matching pair", async () => {
    const token = await issueCsrfToken(SECRET);
    const res = await csrfGuard(makeReq("POST", { cookieToken: token, headerToken: token }));
    expect(res).toBeNull();
  });

  it("enforces the same rule on PUT, PATCH, DELETE", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await csrfGuard(makeReq(method));
      expect(res!.status).toBe(403);
    }
    const token = await issueCsrfToken(SECRET);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await csrfGuard(
        makeReq(method, { cookieToken: token, headerToken: token }),
      );
      expect(res).toBeNull();
    }
  });
});

describe("csrfGuard — misconfiguration", () => {
  it("returns 503 when JWT_SECRET is unset, regardless of cookie/header", async () => {
    setEnv({ JWT_SECRET: undefined });
    const res = await csrfGuard(makeReq("POST"));
    expect(res!.status).toBe(503);
    expect(await res!.json()).toEqual({ error: "auth_not_configured" });
  });

  it("503 takes precedence over csrf_invalid (fail closed)", async () => {
    setEnv({ JWT_SECRET: undefined });
    const token = "anything.signed-or-not";
    const res = await csrfGuard(makeReq("POST", { cookieToken: token, headerToken: token }));
    expect(res!.status).toBe(503);
  });
});

describe("csrfGuard — cookie parsing", () => {
  it("ignores other cookies and finds bridge_csrf_token by name", async () => {
    const token = await issueCsrfToken(SECRET);
    const req = new Request("http://localhost/api/trpc/anything", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // intentionally include unrelated cookies before and after
        cookie: `theme=dark; ${CSRF_COOKIE}=${token}; locale=en`,
        [CSRF_HEADER]: token,
      },
      body: JSON.stringify({}),
    });
    expect(await csrfGuard(req)).toBeNull();
  });

  it("returns 403 when cookie value contains spaces or commas (malformed)", async () => {
    const req = new Request("http://localhost/api/trpc/anything", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${CSRF_COOKIE}=`,
        [CSRF_HEADER]: "",
      },
      body: JSON.stringify({}),
    });
    const res = await csrfGuard(req);
    expect(res!.status).toBe(403);
  });
});
