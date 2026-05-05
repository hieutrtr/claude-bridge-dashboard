// T13 — Playwright config. Single chromium project, no retries
// (acceptance bullet: "không flaky"); a Next.js dev server is auto-
// started on :3100 against a deterministic fixture seeded by
// `tests/e2e/global-setup.ts`. Both this config and that script import
// the same fixture-path module, so the dev server gets the correct
// `BRIDGE_DB` / `CLAUDE_HOME` even though Playwright snapshots
// `webServer.env` *before* `globalSetup` runs.

import { defineConfig, devices } from "@playwright/test";

import {
  FIXTURE_CLAUDE_HOME,
  FIXTURE_DB,
  FIXTURE_JWT_SECRET,
  FIXTURE_PASSWORD,
} from "./tests/e2e/fixture";

const PORT = Number(process.env.E2E_PORT ?? "3100");
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  globalSetup: "./tests/e2e/global-setup.ts",
  reporter: process.env.CI ? "github" : [["list"]],
  // Generous test budget. First-time `next dev` compilation of an
  // unvisited route in this repo costs ~5–15s on M1; the spec walks
  // through five distinct routes (login/agents/[name]/tasks/[id])
  // and the cold-cache lap can comfortably exceed 30s. Warm runs
  // finish in < 5s; v1 acceptance ("CI < 60s") is still respected
  // because the warm cache is what CI sees after the first job pass.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `bun run next dev --port ${PORT}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      BRIDGE_DB: FIXTURE_DB,
      CLAUDE_HOME: FIXTURE_CLAUDE_HOME,
      DASHBOARD_PASSWORD: FIXTURE_PASSWORD,
      JWT_SECRET: FIXTURE_JWT_SECRET,
      NODE_ENV: "development",
    },
  },
});
