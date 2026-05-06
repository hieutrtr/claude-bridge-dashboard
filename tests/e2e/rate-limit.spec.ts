// Phase 2 — Rate-limit guard returns 429 once the per-user mutation
// bucket is depleted. Default capacity is 30/min, refill 0.5/sec. We
// post a burst large enough to drain the bucket and assert at least
// one 429 lands.
//
// This spec runs LAST alphabetically (`rate-limit.spec.ts` follows the
// other Phase 2 specs in lexicographic order). After it depletes the
// shared bucket, no later POSTs in the suite would be reliable — so it
// must be the final POST-heavy spec.
//
// We send the burst via `fetch` from inside the page so the browser
// reuses the existing session + CSRF cookie. tRPC validation/MCP
// errors after the guard pass are fine; we only count 429s.

import { expect, test } from "@playwright/test";

import { CSRF_COOKIE, CSRF_HEADER } from "../../src/lib/csrf";
import { FIXTURE_PASSWORD } from "./fixture";

test("phase-2 rate-limit: burst of mutations triggers 429", async ({ page }) => {
  // Cold-start authentication so the bucket is keyed to a known user
  // ('owner' for the single-user setup) and the CSRF cookie is set.
  // Land on the dev server origin first so `page.evaluate(fetch(...))`
  // resolves the relative URL.
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

  // Read the CSRF cookie that login set so each burst request can echo
  // it as the `x-csrf-token` header (double-submit pattern).
  const csrfCookie = (await page.context().cookies()).find(
    (c) => c.name === CSRF_COOKIE,
  );
  expect(csrfCookie?.value).toBeTruthy();
  const csrfToken = csrfCookie!.value;

  const burstSize = 40;
  const result = await page.evaluate(
    async (args: { burst: number; csrfHeader: string; csrfToken: string }) => {
      const statuses: number[] = [];
      for (let i = 0; i < args.burst; i += 1) {
        const r = await fetch("/api/trpc/tasks.dispatch", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [args.csrfHeader]: args.csrfToken,
          },
          body: JSON.stringify({
            json: {
              agentName: "smoke-agent",
              prompt: `rate-limit burst ${i}`,
            },
          }),
        });
        statuses.push(r.status);
      }
      return statuses;
    },
    { burst: burstSize, csrfHeader: CSRF_HEADER, csrfToken },
  );

  const limited = result.filter((s) => s === 429);
  expect(limited.length).toBeGreaterThan(0);
});
