// Phase 2 — Dispatch dialog (⌘K) opens, lists agents, closes via the
// cancel button. The dialog reads agents through `agents.list` (a tRPC
// query that hits the SQLite agents table directly — no daemon), so
// the seeded `smoke-agent` is enough to exercise the happy path.
//
// Submission isn't tested here: the underlying procedure shells out to
// the MCP daemon, which isn't running in the e2e fixture. Dialog open
// + cancel is the read-side of the dispatch UI; happy-path POST is
// covered by the integration test (mocked MCP client).

import { expect, test } from "@playwright/test";

import { FIXTURE_AGENT, FIXTURE_PASSWORD } from "./fixture";

test("phase-2 dispatch dialog: ⌘K opens, lists agents, cancels", async ({
  page,
}) => {
  // Land on the dev server origin so in-page `fetch` can resolve a
  // relative URL — `about:blank` has no baseURL.
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

  await page.goto("/agents");
  await expect(
    page.getByRole("heading", { level: 1, name: "Agents" }),
  ).toBeVisible();

  // ⌘K — the dialog handler accepts metaKey OR ctrlKey + 'k'.
  // Playwright's "ControlOrMeta" maps to whichever the host OS uses.
  await page.keyboard.press("ControlOrMeta+k");

  const dialog = page.getByRole("dialog", { name: /dispatch task/i });
  await expect(dialog).toBeVisible();

  // The seeded agent is listed in the agent <select> — the dialog
  // populated `agents.list` via tRPC.
  await expect(
    dialog.locator(`select[name="agentName"] option:has-text("${FIXTURE_AGENT.name}")`),
  ).toHaveCount(1);

  // Cancel via the dedicated button (the dialog also closes via Esc /
  // the ✕ icon — happy-path cancel is enough for this smoke).
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});
