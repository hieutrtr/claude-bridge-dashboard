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

beforeEach(async () => {
  setEnv({
    DASHBOARD_PASSWORD: undefined,
    JWT_SECRET: undefined,
    RATE_LIMIT_LOGIN_PER_MIN: undefined,
  });
  // Reset the login bucket between tests so a previous test's exhaustion
  // does not bleed into the next.
  const m = await import("../../src/server/rate-limit-login");
  m._reset();
});

afterEach(() => {
  // Restore the snapshot keys touched by tests.
  setEnv({
    DASHBOARD_PASSWORD: ORIGINAL_ENV.DASHBOARD_PASSWORD,
    JWT_SECRET: ORIGINAL_ENV.JWT_SECRET,
    RATE_LIMIT_LOGIN_PER_MIN: ORIGINAL_ENV.RATE_LIMIT_LOGIN_PER_MIN,
  });
});

function makeReq(body: unknown, xff = "10.0.0.1"): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": xff,
    },
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

  it("returns 429 after 5 rapid attempts from the same IP (rate limit)", async () => {
    setEnv({ DASHBOARD_PASSWORD: "letmein", JWT_SECRET: "supersecret-key" });
    // 5 attempts (some wrong, some malformed) from the same IP all spend tokens
    for (let i = 0; i < 5; i++) {
      await POST(makeReq({ password: "wrong" }, "1.2.3.4"));
    }
    const res = await POST(makeReq({ password: "letmein" }, "1.2.3.4"));
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("rate-limit applies before body parsing — malformed bodies still spend tokens", async () => {
    setEnv({ DASHBOARD_PASSWORD: "letmein", JWT_SECRET: "supersecret-key" });
    for (let i = 0; i < 5; i++) {
      await POST(makeReq("not-json{", "5.6.7.8"));
    }
    const res = await POST(makeReq({ password: "letmein" }, "5.6.7.8"));
    expect(res.status).toBe(429);
  });
});
