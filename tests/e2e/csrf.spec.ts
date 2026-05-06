// Phase 2 — CSRF guard on POST /api/trpc/* returns 403 when the
// `x-csrf-token` header is missing or doesn't match the cookie. The
// guard runs *before* the tRPC handler and *before* rate-limit, so a
// rejected request never decrements the bucket — this spec is safe to
// run alongside the rate-limit spec without polluting state.

import { expect, test } from "@playwright/test";

import { FIXTURE_PASSWORD } from "./fixture";

test("phase-2 csrf: POST tRPC mutation without token → 403 csrf_invalid", async ({
  page,
}) => {
  // Auth so we get past the route gate; the CSRF guard sits inside the
  // tRPC handler regardless. Land on the dev server first so in-page
  // `fetch` can resolve relative URLs.
  await page.goto("/login");

  const loginStatus = await page.evaluate(async (password: string) => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    return r.status;
  }, FIXTURE_PASSWORD);
  expect(loginStatus).toBe(200);

  // POST without `x-csrf-token` — guard rejects with 403 and writes a
  // `csrf_invalid` audit row.
  const result = await page.evaluate(async () => {
    const r = await fetch("/api/trpc/tasks.dispatch?batch=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        "0": {
          json: {
            agentName: "smoke-agent",
            prompt: "this should be rejected",
          },
        },
      }),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { status: r.status, body };
  });

  expect(result.status).toBe(403);
  expect(result.body).toEqual({ error: "csrf_invalid" });
});
