// Phase 3 — schedule-create + pause + delete critical flow. Drives the
// `/schedules` page through the dialog → row-action → typed-name
// confirmation pipeline. Mutations land on the fake stdio MCP daemon
// configured in `playwright.config.ts` (env `CLAUDE_BRIDGE_MCP_COMMAND`),
// which mutates the same SQLite fixture the dashboard reads, so each
// follow-up navigation reflects the prior action.
//
// Flow:
//   1) login + open `/schedules`
//   2) "New schedule" → dialog opens, agent listed, cron picker shows
//      a valid hourly cadence, cost-forecast block reflects an
//      insufficient-history fallback (the seeded smoke task's cost is
//      the only sample), submit → success id rendered
//   3) Refresh `/schedules` → new schedule row visible
//   4) Click Pause → button label flips to Resume after the network
//      round-trip (the daemon flips `enabled=0`)
//   5) Click Delete → DangerConfirm; type the schedule name → Delete
//      succeeds → row disappears after refresh

import { expect, test } from "@playwright/test";

import { FIXTURE_AGENT, FIXTURE_PASSWORD } from "./fixture";

const NEW_SCHEDULE_NAME = "e2e-create-flow";
const NEW_SCHEDULE_PROMPT = "Run an end-to-end smoke check";

test("phase-3 schedules flow: create → pause → delete with typed-name confirm", async ({
  page,
}) => {
  // 1) Authenticate. Land on /login first so `page.evaluate(fetch())`
  //    can resolve the relative URL — same pattern as smoke.spec.
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

  // 2) Open the schedules page and trigger the create dialog.
  await page.goto("/schedules");
  await expect(
    page.getByRole("heading", { level: 1, name: "Schedules" }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: /open schedule-create dialog/i })
    .click();

  const dialog = page.getByRole("dialog", { name: /new schedule/i });
  await expect(dialog).toBeVisible();

  // The seeded smoke-agent is the default agent option.
  await expect(
    dialog.locator(`select[name="agentName"] option:has-text("${FIXTURE_AGENT.name}")`),
  ).toHaveCount(1);

  // Cron picker defaults to the "hourly" preset (60 min). The human
  // label is rendered by cronstrue — assert on a fragment that's
  // robust to phrasing drift.
  await expect(dialog.getByTestId("cron-human-label")).toContainText(/hour/i);
  await expect(dialog.getByTestId("cron-next-fires").locator("li")).toHaveCount(3);

  // Fill the form. Name + prompt are required for a clean audit row;
  // the cron picker is already valid via the default preset.
  await dialog.locator('input[name="name"]').fill(NEW_SCHEDULE_NAME);
  await dialog.locator('textarea[name="prompt"]').fill(NEW_SCHEDULE_PROMPT);

  // Cost forecast: with the smoke fixture only carrying one cost-bearing
  // task ($0.1234), the forecast settles into either an estimate or
  // insufficient-history state. Either is fine — the assertion is that
  // the loading sentinel resolves.
  await expect(dialog.getByTestId("cost-forecast-loading")).toHaveCount(0, {
    timeout: 15_000,
  });

  await dialog.getByRole("button", { name: /create schedule/i }).click();

  // Success state renders the daemon-assigned id. The fake MCP returns
  // a `Schedule #N created` text envelope and the dashboard extracts
  // the id from the regex.
  await expect(dialog.getByText(/Schedule created\./)).toBeVisible({ timeout: 15_000 });
  await expect(dialog.locator("text=/^#\\d+$/")).toBeVisible();
  await dialog.getByRole("button", { name: /^Dismiss$/ }).click();
  await expect(dialog).toBeHidden();

  // 3) Re-fetch the list — server component, full page navigation.
  await page.goto("/schedules");
  const newRow = page
    .locator('tr[data-testid="schedule-row"]')
    .filter({ hasText: NEW_SCHEDULE_NAME });
  await expect(newRow).toHaveCount(1);

  // 4) Pause: click Pause → label flips to Resume after server-confirm.
  //    The button test-id swaps from `schedule-pause-trigger` to
  //    `schedule-resume-trigger` once the network round-trip resolves
  //    and the row optimistically updates.
  await newRow.getByTestId("schedule-pause-trigger").click();
  await expect(newRow.getByTestId("schedule-resume-trigger")).toBeVisible({
    timeout: 15_000,
  });

  // 5) Delete: typed-name confirmation. The DangerConfirm dialog
  //    requires the user to type the schedule name verbatim before the
  //    Delete button enables.
  await newRow.getByTestId("schedule-delete-trigger").click();
  const confirmDialog = page.getByRole("dialog", {
    name: new RegExp(`Delete schedule ${NEW_SCHEDULE_NAME}`, "i"),
  });
  await expect(confirmDialog).toBeVisible();

  const confirmButton = confirmDialog.locator('[data-role="confirm-action"]');
  await expect(confirmButton).toBeDisabled();

  await confirmDialog.locator('[data-role="confirm-input"]').fill(NEW_SCHEDULE_NAME);
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  // Success state replaces the form with a Close-only footer. The
  // success copy is `${verb}ed.` so the literal text reads
  // "Deleteed." (a known cosmetic glitch in the shared
  // DangerConfirm view); the Close button is the structural signal
  // and avoids pinning that copy.
  await expect(
    confirmDialog.getByRole("button", { name: /^Close$/ }),
  ).toBeVisible({ timeout: 15_000 });
  await confirmDialog.getByRole("button", { name: /^Close$/ }).click();

  // The page refreshes via `useRouter().refresh()` after onSuccess; let
  // the server component re-render and assert the row is gone. We do a
  // hard reload to avoid relying on the soft-refresh code path that
  // smoke.spec.ts already documents as flaky under Playwright + Next
  // dev.
  await page.goto("/schedules");
  await expect(
    page
      .locator('tr[data-testid="schedule-row"]')
      .filter({ hasText: NEW_SCHEDULE_NAME }),
  ).toHaveCount(0);
});
