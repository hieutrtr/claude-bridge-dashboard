import { describe, it, expect } from "bun:test";

import { POST } from "../../app/api/auth/logout/route";
import { SESSION_COOKIE } from "../../src/lib/auth";

describe("POST /api/auth/logout", () => {
  it("clears the session cookie and returns 200", async () => {
    const req = new Request("http://localhost/api/auth/logout", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    // Cleared cookie has Max-Age=0 in Next's serialiser.
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Path=/");
  });
});
