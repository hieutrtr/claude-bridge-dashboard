// Phase 2 — `/audit` page renders for an authenticated owner. Read-only
// spec: the route is a server component that calls `audit.list` via a
// tRPC `createCaller`, so this only needs the dashboard SQLite fixture
// (the Phase 1 global setup already migrates `audit_log` into the
// fixture DB at boot via `runMigrations`). No daemon, no MCP.

import { expect, test } from "@playwright/test";

import { FIXTURE_PASSWORD } from "./fixture";

test("phase-2 audit view: owner sees /audit page heading + filters", async ({
  page,
}) => {
  // Authenticate first; `/audit` is behind the same middleware-gated
  // shell as every other dashboard route. We need to land on the dev
  // server origin before `page.evaluate(fetch(...))` can resolve a
  // relative URL — `about:blank` doesn't have a baseURL.
  await page.goto("/login");

  const status = await page.evaluate(async (password: string) => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    return r.status;
  }, FIXTURE_PASSWORD);
  expect(status).toBe(200);

  await page.goto("/audit");
  await expect(page).toHaveURL(/\/audit$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Audit log" }),
  ).toBeVisible();

  // The filter strip is a plain `<form method="get">` — assert that the
  // action input exists so we know the page rendered the filter UI
  // rather than crashing into the error boundary.
  await expect(page.locator('input[name="action"]')).toBeVisible();
});
