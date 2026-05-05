import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { POST } from "../../app/api/auth/login/route";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "../../src/lib/auth";
import { CSRF_COOKIE, verifyCsrfToken } from "../../src/lib/csrf";

const ORIGINAL_ENV = { ...process.env };

function setEnv(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  setEnv({ DASHBOARD_PASSWORD: undefined, JWT_SECRET: undefined });
});

afterEach(() => {
  // Restore the snapshot keys touched by tests.
  setEnv({
    DASHBOARD_PASSWORD: ORIGINAL_ENV.DASHBOARD_PASSWORD,
    JWT_SECRET: ORIGINAL_ENV.JWT_SECRET,
  });
});

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  it("returns 200 + Set-Cookie on correct password", async () => {
    setEnv({ DASHBOARD_PASSWORD: "letmein", JWT_SECRET: "supersecret-key" });
    const res = await POST(makeReq({ password: "letmein" }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
  });

  it("issues a CSRF cookie alongside the session on success", async () => {
    setEnv({ DASHBOARD_PASSWORD: "letmein", JWT_SECRET: "supersecret-key" });
    const res = await POST(makeReq({ password: "letmein" }));
    expect(res.status).toBe(200);
    // NextResponse.cookies.set with multiple names produces multiple
    // Set-Cookie entries that we can read individually via getSetCookie().
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    const csrf = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
    expect(session).toBeDefined();
    expect(csrf).toBeDefined();
    // CSRF cookie must be readable by client JS (NOT HttpOnly).
    expect(csrf!.toLowerCase()).not.toContain("httponly");
    expect(csrf!.toLowerCase()).toContain("samesite=lax");
    expect(csrf!).toContain("Path=/");
    expect(csrf!).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    // The cookie value must be a valid CSRF token under the secret.
    const m = csrf!.match(new RegExp(`^${CSRF_COOKIE}=([^;]+)`));
    expect(m).not.toBeNull();
    expect(await verifyCsrfToken(m![1], "supersecret-key")).toBe(true);
  });

  it("returns 401 on wrong password without setting a cookie", async () => {
    setEnv({ DASHBOARD_PASSWORD: "letmein", JWT_SECRET: "supersecret-key" });
    const res = await POST(makeReq({ password: "nope" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.json();
    expect(body).toEqual({ error: "invalid_password" });
  });

  it("returns 400 on malformed body", async () => {
    setEnv({ DASHBOARD_PASSWORD: "letmein", JWT_SECRET: "supersecret-key" });
    const res = await POST(makeReq({ wrongField: "x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid_body" });
  });

  it("returns 400 when body is not valid JSON", async () => {
    setEnv({ DASHBOARD_PASSWORD: "letmein", JWT_SECRET: "supersecret-key" });
    const res = await POST(makeReq("not-json{"));
    expect(res.status).toBe(400);
  });

  it("returns 503 when DASHBOARD_PASSWORD is unset", async () => {
    setEnv({ DASHBOARD_PASSWORD: undefined, JWT_SECRET: "supersecret-key" });
    const res = await POST(makeReq({ password: "anything" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "auth_not_configured" });
  });

  it("returns 503 when JWT_SECRET is unset", async () => {
    setEnv({ DASHBOARD_PASSWORD: "letmein", JWT_SECRET: undefined });
    const res = await POST(makeReq({ password: "letmein" }));
    expect(res.status).toBe(503);
  });
});
