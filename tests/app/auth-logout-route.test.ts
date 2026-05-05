import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { POST } from "../../app/api/auth/logout/route";
import { SESSION_COOKIE } from "../../src/lib/auth";
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from "../../src/lib/csrf";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "logout-test-secret-please-do-not-use-in-prod";

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

describe("POST /api/auth/logout", () => {
  it("rejects logout without a CSRF token (403, session NOT cleared)", async () => {
    const req = new Request("http://localhost/api/auth/logout", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).not.toContain(`${SESSION_COOKIE}=`);
  });

  it("clears both session and CSRF cookies on a CSRF-valid request", async () => {
    const token = await issueCsrfToken(SECRET);
    const req = new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: `${CSRF_COOKIE}=${token}`,
        [CSRF_HEADER]: token,
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    const csrf = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
    expect(session).toBeDefined();
    expect(csrf).toBeDefined();
    expect(session!).toContain("Max-Age=0");
    expect(csrf!).toContain("Max-Age=0");
    expect(session!).toContain("Path=/");
    expect(csrf!).toContain("Path=/");
  });
});
