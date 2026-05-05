// T13 — Constants + path helpers shared between the global setup
// script (which writes the fixture DB + JSONL) and the spec (which
// asserts on visible text). Both `playwright.config.ts` (which
// evaluates env vars *before* `globalSetup` runs) and the setup itself
// import this module so they agree on the on-disk layout.
//
// IMPORTANT — fixture lives in `os.tmpdir()`, NOT inside the project
// tree. SQLite WAL writes touch the DB file on every query; if the
// fixture is under `claude-bridge-dashboard/`, Next.js dev's watchpack
// sees those mtime changes and fires Fast Refresh, which unmounts the
// login form mid-submit and breaks `router.replace` navigation. (Yes,
// we burned an hour on this. The fix is one line — `tmpdir()` — but
// the diagnostic was painful, so this comment stays.)

import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE_DIR = join(tmpdir(), "claude-bridge-dashboard-e2e");
export const FIXTURE_DB = join(FIXTURE_DIR, "bridge.db");
export const FIXTURE_CLAUDE_HOME = join(FIXTURE_DIR, ".claude");

export const FIXTURE_PASSWORD = "smoke-pass";
export const FIXTURE_JWT_SECRET = "smoke-jwt-secret-development-only";

export const FIXTURE_AGENT = {
  name: "smoke-agent",
  projectDir: "/Users/test/projects/smoke",
  sessionId: "smoke-session-id",
  task: {
    prompt: "Investigate flaky test",
    resultPhrase: "E2E smoke result",
  },
} as const;
