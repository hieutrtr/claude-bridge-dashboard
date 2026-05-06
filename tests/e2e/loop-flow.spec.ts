// Phase 3 — loop critical flow. Drives the `/loops` page through the
// start-loop dialog, the loop-detail cancel control, and the
// pending-approval gate. Mutations land on the fake stdio MCP daemon
// configured in `playwright.config.ts` (env `CLAUDE_BRIDGE_MCP_COMMAND`),
// which mutates the same SQLite fixture the dashboard reads.
//
// Two flows in one spec (Playwright's worker model + the rate-limit
// spec already establish that one-shot bursts deplete the per-user
// bucket; we keep this spec lean to avoid clobbering the other Phase 2
// specs' shared mutation budget):
//
//   A) Start → cancel: open the "Start loop" dialog, submit a manual-
//      gated loop, follow the success link to /loops/[id], cancel via
//      the typed-prefix DangerConfirm. Confirm the cancel-button
//      disappears once the loop reaches the cancelled terminal state.
//   B) Approve gate: navigate to a pre-seeded loop with
//      `pending_approval=1`, click the large Approve button, expect
//      the resolved-status banner.

import { expect, test } from "@playwright/test";

import {
  FIXTURE_AGENT,
  FIXTURE_LOOP_PENDING_APPROVAL,
  FIXTURE_PASSWORD,
} from "./fixture";

const NEW_LOOP_GOAL = "Investigate the e2e flow for cancellation";

test("phase-3 loop flow: start dialog → cancel via typed-prefix confirm", async ({
  page,
}) => {
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

  // Open the loops listing — the seeded `fixture-loop-running` row
  // should already be visible. We don't assert on its presence in the
  // table because /loops sorts by started_at DESC and a transient
  // server cache could race the assertion under cold compile; the
  // spec's value lies in the dialog→detail flow that follows.
  await page.goto("/loops");
  await expect(
    page.getByRole("heading", { level: 1, name: "Loops" }),
  ).toBeVisible();

  // Open the Start loop dialog.
  await page
    .getByRole("button", { name: /open start-loop dialog/i })
    .click();

  const dialog = page.getByRole("dialog", { name: /start loop/i });
  await expect(dialog).toBeVisible();

  // Default agent is the seeded smoke-agent.
  await expect(
    dialog.locator(`select[name="agentName"] option:has-text("${FIXTURE_AGENT.name}")`),
  ).toHaveCount(1);

  // Fill goal; default doneWhen prefix is "manual" (no value required).
  await dialog.locator('textarea[name="goal"]').fill(NEW_LOOP_GOAL);
  await dialog.locator('select[name="doneWhenPrefix"]').selectOption("manual");

  await dialog.getByRole("button", { name: /^Start loop$/ }).click();

  // Success state: the dialog renders a `Loop {loopId}` link to the
  // detail page. Capture the loop_id off the link's href so the rest
  // of the flow knows which row to drive.
  const loopLink = dialog.locator('a[href^="/loops/"]');
  await expect(loopLink).toBeVisible({ timeout: 15_000 });
  const loopHref = await loopLink.getAttribute("href");
  expect(loopHref).toMatch(/^\/loops\/[a-z0-9]+$/);
  const loopId = loopHref!.replace(/^\/loops\//, "");

  await dialog.getByRole("button", { name: /^Dismiss$/ }).click();
  await expect(dialog).toBeHidden();

  // Navigate to the loop detail page. `page.goto` rather than
  // following the link click, mirroring the smoke spec's documented
  // SPA-click workaround.
  await page.goto(`/loops/${loopId}`);
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(FIXTURE_AGENT.name) }),
  ).toBeVisible();
  await expect(page.getByTestId("loop-status-badge")).toContainText(/running/i);

  // Cancel via the typed-prefix DangerConfirm. The token is the first
  // 8 chars of the loop_id (`LOOP_CANCEL_CONFIRM_LENGTH=8`).
  const cancelTrigger = page.getByTestId("loop-cancel-trigger");
  await expect(cancelTrigger).toBeVisible();
  await cancelTrigger.click();

  const confirmDialog = page.getByRole("dialog", {
    name: /Cancel loop/i,
  });
  await expect(confirmDialog).toBeVisible();
  const confirmButton = confirmDialog.locator('[data-role="confirm-action"]');
  await expect(confirmButton).toBeDisabled();

  const confirmToken = loopId.slice(0, 8);
  await confirmDialog.locator('[data-role="confirm-input"]').fill(confirmToken);
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  // Success state replaces the form with a Close-only footer. The
  // success copy is `${verb}ed.` (so "Canceled." for verb="Cancel" —
  // American spelling), which we deliberately don't pin since the
  // copy may evolve; the Close button is the structural signal.
  await expect(
    confirmDialog.getByRole("button", { name: /^Close$/ }),
  ).toBeVisible({ timeout: 15_000 });
  await confirmDialog.getByRole("button", { name: /^Close$/ }).click();

  // Hard reload to pick up the daemon-of-record state. After cancel,
  // the loop status flips to `cancelled` and the cancel button hides
  // (it returns null for terminal statuses).
  await page.goto(`/loops/${loopId}`);
  await expect(page.getByTestId("loop-status-badge")).toContainText(/cancel/i);
  await expect(page.getByTestId("loop-cancel-trigger")).toHaveCount(0);
});

test("phase-3 loop flow: approve gate clears pending_approval", async ({
  page,
}) => {
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

  await page.goto(`/loops/${FIXTURE_LOOP_PENDING_APPROVAL.loopId}`);

  // The seeded loop has `pending_approval=1`, so `<LoopApprovalGate>`
  // renders at the top of the detail page.
  const gate = page.getByTestId("loop-approval-gate");
  await expect(gate).toBeVisible();

  await gate.getByTestId("loop-approve-button").click();

  // Resolution banner replaces the gate (status="resolved" branch).
  await expect(page.getByTestId("loop-approval-resolved")).toBeVisible({
    timeout: 15_000,
  });

  // After router.refresh() the page server component re-fetches the
  // loop and the gate is gone (pending_approval flipped to false in
  // the daemon's DB). Hard-reload to bypass any soft-refresh quirk.
  await page.goto(`/loops/${FIXTURE_LOOP_PENDING_APPROVAL.loopId}`);
  await expect(page.getByTestId("loop-approval-gate")).toHaveCount(0);
});
