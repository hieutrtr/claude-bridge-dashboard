// T13 — Phase 1 E2E smoke. Read-only happy path:
// `/agents` (anon) → login → `/agents` (authed) → `/agents/[name]`
// (assert seeded task in the agent's Tasks tab) → `/tasks` (assert
// task-id link in the global table) → `/tasks/[id]` (assert result).
//
// Single test, single browser, no retries, no parallel. Read-only:
// the only HTTP `POST` is the login (auth); every other navigation is
// a `GET` driven by `page.goto`.
//
// Why `page.goto` instead of `link.click()`:
// Headless Chromium + `next dev`'s SPA navigation (router.push /
// router.replace) doesn't reliably fire a network request under
// Playwright in this setup — the `<Link>` `onClick` runs but the
// route change never commits. Verified with the dev server's request
// log staying flat while Playwright reported the click went through.
// The browser-driven SPA path is incidental to the smoke (the link's
// `href` proves the navigation contract); we assert the `href` on
// each link and then drive the navigation with `page.goto`. Switching
// to a production build (`next build && next start`) would surface
// SPA-click coverage but doubles wall-time; flagged as Phase 2 polish.

import { expect, test } from "@playwright/test";

import { FIXTURE_AGENT, FIXTURE_PASSWORD } from "./fixture";

test("phase-1 smoke: login → agent → task → result", async ({ page }) => {
  // 1) Anonymous request to a protected route → middleware bounces to
  //    /login?next=/agents. Confirms the auth gate is wired.
  await page.goto("/agents");
  await expect(page).toHaveURL(/\/login(\?.*)?$/);
  await expect(
    page.getByRole("heading", { name: /sign in/i }),
  ).toBeVisible();

  // 2) Submit the login form via in-page `fetch`. The browser stores
  //    the resulting `bridge_dashboard_session` cookie naturally, so
  //    the next `page.goto` is fully authenticated and we still
  //    exercise the middleware-checks-cookie contract end-to-end.
  const status = await page.evaluate(async (password: string) => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    return r.status;
  }, FIXTURE_PASSWORD);
  expect(status).toBe(200);

  // 3) /agents authenticated — see the seeded agent card link.
  await page.goto("/agents");
  await expect(page).toHaveURL(/\/agents$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Agents" }),
  ).toBeVisible();
  const agentCard = page.getByRole("link", {
    name: new RegExp(FIXTURE_AGENT.name, "i"),
  });
  await expect(agentCard).toBeVisible();
  expect(await agentCard.getAttribute("href")).toBe(
    `/agents/${FIXTURE_AGENT.name}`,
  );

  // 4) /agents/[name] — agent detail with the seeded task in the
  //    Tasks tab table. The agent-detail TaskTable doesn't render a
  //    per-row link to /tasks/[id]; we assert the prompt text is
  //    visible (validates the agent → tasks join) and pick up the
  //    task-id link from the global /tasks page in step 5.
  await page.goto(`/agents/${FIXTURE_AGENT.name}`);
  await expect(
    page.getByRole("heading", { level: 1, name: FIXTURE_AGENT.name }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", {
      name: new RegExp(FIXTURE_AGENT.task.prompt, "i"),
    }),
  ).toBeVisible();

  // 5) /tasks — global task table; pick the task-id link for the
  //    `done` row (cost is non-null, so the cost column is filled).
  //    The link text is just the numeric task id; we filter to the
  //    /tasks/<n> hrefs to dodge the agent-name link in the same row.
  await page.goto("/tasks");
  await expect(page).toHaveURL(/\/tasks$/);
  const taskIdLink = page.locator('a[href^="/tasks/"]').first();
  await expect(taskIdLink).toBeVisible();
  const taskHref = await taskIdLink.getAttribute("href");
  expect(taskHref).toMatch(/^\/tasks\/\d+$/);

  // 6) /tasks/[id] — result text rendered.
  await page.goto(taskHref!);
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
  await expect(
    page.getByRole("heading", { level: 1, name: /^#\d+$/ }),
  ).toBeVisible();
  await expect(page.getByText(FIXTURE_AGENT.task.resultPhrase)).toBeVisible();
});
