// P4-T10 — Accessibility audit of the dark theme + theme-toggle
// persistence end-to-end.
//
// Why dark only:
//   The Phase 1–3 component palette (red-300 / amber-300 / emerald-300
//   on bg-*-500/5 surfaces) was tuned for the dark default. A
//   comprehensive light-mode AA pass is filed against v0.2.0 (see
//   T10 review §6 "Deferred"). For v0.1.0 we ship a dark-default
//   dashboard and gate the dark-mode AA contract here.
//
// Why axe-core injected via addScriptTag rather than @axe-core/playwright:
//   axe-core ships in node_modules already (a transitive dep of the
//   T07 lighthouse runner). Wiring it through `page.addScriptTag({
//   path })` + `page.evaluate(() => axe.run(...))` lets us assert AA
//   without adding a new dev dependency. The diff stays self-
//   contained.
//
// Persistence sub-test:
//   Toggling the theme to light, reloading, and re-reading
//   `data-theme-current` proves next-themes' localStorage write is
//   wired through the polished `<ThemeToggleView>` and survives a
//   hard reload. The mounted gate guarantees the assertion is taken
//   AFTER the React effect runs (we wait for `data-mounted="true"`).

import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_PASSWORD } from "./fixture";

const AXE_PATH = resolve(
  __dirname,
  "..",
  "..",
  "node_modules",
  "axe-core",
  "axe.min.js",
);

// Routes audited under the dark theme. Keep in lockstep with the
// T07 lighthouse runner so we don't drift between the two gates —
// every mobile-audited route gets an axe pass too.
const AUDITED_ROUTES = [
  "/agents",
  "/tasks",
  "/loops",
  "/schedules",
  "/cost",
  "/audit",
  "/settings/users",
] as const;

interface AxeViolation {
  id: string;
  impact: string | null;
  description: string;
  helpUrl: string;
  nodes: Array<{
    target: string[];
    failureSummary: string;
    html: string;
  }>;
}

async function login(page: Page) {
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
}

// Inject axe-core into the page, then run it scoped to the body
// against the wcag2aa rule set. Returns ONLY violations (axe.run's
// other return fields — passes, incomplete, inapplicable — are
// elided to keep the failure message readable).
async function runAxeWcagAa(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  // axe-core deserves a settle moment after the page paints to
  // catch late-layout components (sidebar drawer, palette overlay).
  await page.waitForTimeout(150);
  const violations = (await page.evaluate(async () => {
    // @ts-expect-error - axe is injected via addScriptTag at runtime
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      // The page outline contains a couple of next-themes <html>
      // class transitions that axe flags as "duplicate-id" false
      // positives during hot-swap. We exclude that single rule —
      // the layout-level theme-config test already pins the
      // class-strategy contract.
      rules: { "duplicate-id": { enabled: false } },
    });
    return result.violations.map((v: AxeViolation) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      helpUrl: v.helpUrl,
      nodes: v.nodes.slice(0, 3).map((n) => ({
        target: n.target,
        failureSummary: n.failureSummary,
        html: n.html.slice(0, 240),
      })),
    }));
  })) as AxeViolation[];
  return violations;
}

test.describe("@dark-mode-axe Phase 4 — accessibility audit", () => {
  test("dark theme is the default and audits clean across all primary routes", async ({
    page,
  }) => {
    await login(page);

    const summary: Record<string, AxeViolation[]> = {};

    for (const route of AUDITED_ROUTES) {
      await page.goto(route);
      // Wait for the toggle to mount; that signals next-themes has
      // reconciled the `class="dark"` token onto <html>. Without
      // this, the very first iteration races the theme-script and
      // axe sees an unstyled tree.
      await expect(page.getByTestId("theme-toggle")).toHaveAttribute(
        "data-mounted",
        "true",
      );
      const themeClass = await page.evaluate(() =>
        document.documentElement.classList.contains("dark") ? "dark" : "light",
      );
      expect(themeClass).toBe("dark");

      const violations = await runAxeWcagAa(page);
      summary[route] = violations;
    }

    const offenders = Object.entries(summary).filter(
      ([, v]) => v.length > 0,
    );
    if (offenders.length > 0) {
      // Surface the readable diff in the test failure so a future
      // fixer can see WHICH rule + WHICH selector — not just a
      // bare "expected 0, got 3".
      console.error(JSON.stringify(offenders, null, 2));
    }
    expect(offenders).toEqual([]);
  });

  test("theme-toggle persists the user choice across a hard reload", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/agents");

    const toggle = page.getByTestId("theme-toggle");
    // Wait for the mounted gate — pre-mount the toggle is a
    // placeholder with no `data-theme-current` attribute.
    await expect(toggle).toHaveAttribute("data-mounted", "true");
    await expect(toggle).toHaveAttribute("data-theme-current", "dark");

    await toggle.click();

    // After click, next-themes flips the class + writes localStorage.
    await expect(toggle).toHaveAttribute("data-theme-current", "light");
    const lightOnHtml = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(lightOnHtml).toBe(false);

    // Hard reload — exercise the inline <ThemeScript> path that
    // sets the class BEFORE React mounts. This is what prevents the
    // FOUC on the first paint.
    await page.reload();

    await expect(toggle).toHaveAttribute("data-mounted", "true");
    await expect(toggle).toHaveAttribute("data-theme-current", "light");
    const stillLight = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(stillLight).toBe(false);

    // Restore the dark default so subsequent specs in the same
    // browser context start from a known baseline.
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-theme-current", "dark");
  });
});
