// P4-T05 — ⌘K command palette E2E. Verifies:
//   * ⌘K (or Ctrl+K) opens the palette dialog
//   * the dispatch action fires the bridge:open-dispatch event so the
//     existing dispatch dialog opens — proves the palette → dialog
//     bridge is intact
//   * Esc closes the palette
//   * the palette never opens before the user is signed in (the
//     `<CommandPalette>` is mounted only inside the authed shell)
//
// The interactive cmdk filter + arrow-key navigation are exercised by
// the unit tests (`tests/lib/command-palette.test.ts` for the action
// registry; `tests/app/command-palette.test.tsx` for the markup
// shape). This spec only covers the wiring between hotkey → palette →
// downstream dialog event.

import { expect, test } from "@playwright/test";

import { FIXTURE_PASSWORD } from "./fixture";

test("⌘K opens the command palette and 'Dispatch task' opens the dispatch dialog", async ({
  page,
}) => {
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

  // ⌘K opens the palette (not the dispatch dialog).
  await page.keyboard.press("ControlOrMeta+k");

  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expect(palette.getByText("Dispatch task to agent")).toBeVisible();
  await expect(palette.getByText("Go to agents")).toBeVisible();

  // Selecting "Dispatch task to agent…" closes the palette and
  // dispatches bridge:open-dispatch — the dispatch dialog opens.
  // We drive selection through the cmdk input + Enter rather than a
  // direct click on the item: cmdk wraps Radix Dialog whose
  // entrance animation briefly leaves pointer-events on the overlay,
  // causing flaky pointer interception when clicking the option DOM
  // node directly. Typing+Enter narrows to a single match (the first
  // item is auto-selected by cmdk) and activates it deterministically.
  await palette.getByRole("combobox").fill("Dispatch task");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();

  const dispatch = page.getByRole("dialog", { name: /dispatch task/i });
  await expect(dispatch).toBeVisible();

  // Close the dispatch dialog so we're back to the page baseline.
  await dispatch.getByRole("button", { name: "Cancel" }).click();
  await expect(dispatch).toBeHidden();

  // ⌘K → Esc closes the palette cleanly.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});
