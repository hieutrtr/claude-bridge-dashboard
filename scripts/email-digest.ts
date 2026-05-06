#!/usr/bin/env bun
// P4-T06 — email-digest CLI entry point.
//
// Run hourly via OS cron or the daemon's `bridge_schedule_add` MCP
// surface (Phase 2 invariant — every recurring job uses the same
// scheduling mechanism). The orchestration logic lives in
// `src/server/email-digest.ts`; this file is a thin wrapper that
// reads env, opens the DB via the existing pool, calls
// `runEmailDigest`, and prints a one-line summary so the cron log
// is easy to scan.
//
// Sample crontab line (sends at the top of every hour):
//
//   0 * * * * cd /path/to/dashboard && /usr/local/bin/bun run scripts/email-digest.ts
//
// Sample bridge schedule (preferred — keeps the daemon as the
// single source of truth for scheduled work):
//
//   bridge_schedule_add({
//     agent_name: "<dashboard-host-agent>",
//     prompt: "bun run scripts/email-digest.ts",
//     interval_minutes: 60,
//     name: "dashboard-email-digest",
//   })

import { runEmailDigest } from "../src/server/email-digest";

async function main(): Promise<void> {
  const result = await runEmailDigest();
  // eslint-disable-next-line no-console
  console.log(
    `[email-digest] considered=${result.considered} sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`,
  );
  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[email-digest] fatal:", err);
  process.exit(1);
});
