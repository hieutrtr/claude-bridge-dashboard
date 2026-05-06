// P2-T05 — smoke perf test. Seed 5 000 rows; assert the three filter
// shapes the viewer issues complete in < 50 ms median over 10 iterations.
//
// Skippable via BUN_TEST_PERF=0 (e.g. on slow / shared CI).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appRouter } from "../../src/server/routers/_app";
import { resetDb } from "../../src/server/db";
import { runMigrations } from "../../src/server/migrate";

const SKIP = process.env.BUN_TEST_PERF === "0";
const ITERATIONS = 10;
const BUDGET_MS = 50;

let tmpDir: string;
let dbPath: string;
const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "audit-router-perf-"));
  dbPath = join(tmpDir, "bridge.db");
  process.env.BRIDGE_DB = dbPath;
  resetDb();

  const db = new Database(dbPath);
  runMigrations(db);
  db.exec("BEGIN");
  const stmt = db.prepare(`
    INSERT INTO audit_log
      (user_id, action, resource_type, resource_id,
       payload_json, ip_hash, user_agent, request_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const actions = [
    "task.dispatch",
    "task.kill",
    "loop.approve",
    "loop.reject",
    "csrf_invalid",
    "rate_limit_blocked",
  ];
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 5000; i++) {
    const action = actions[i % actions.length]!;
    const resourceType =
      action === "csrf_invalid" || action === "rate_limit_blocked"
        ? "auth"
        : action.startsWith("task")
          ? "task"
          : "loop";
    stmt.run(
      i % 3 === 0 ? null : "owner",
      action,
      resourceType,
      String(i),
      `{"i":${i}}`,
      null,
      null,
      null,
      t0 + i,
    );
  }
  db.exec("COMMIT");
  db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_BRIDGE_DB === undefined) {
    delete process.env.BRIDGE_DB;
  } else {
    process.env.BRIDGE_DB = ORIGINAL_BRIDGE_DB;
  }
  resetDb();
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

(SKIP ? describe.skip : describe)("audit.list — perf smoke (5 000 rows)", () => {
  it("default list completes within budget", async () => {
    const caller = appRouter.createCaller({});
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t = performance.now();
      const r = await caller.audit.list({ limit: 100 });
      samples.push(performance.now() - t);
      expect(r.items.length).toBe(100);
    }
    expect(median(samples)).toBeLessThan(BUDGET_MS);
  });

  it("filtered by action completes within budget", async () => {
    const caller = appRouter.createCaller({});
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t = performance.now();
      const r = await caller.audit.list({
        action: "task.dispatch",
        limit: 100,
      });
      samples.push(performance.now() - t);
      expect(r.items.length).toBeGreaterThan(0);
    }
    expect(median(samples)).toBeLessThan(BUDGET_MS);
  });

  it("filtered by since completes within budget", async () => {
    const caller = appRouter.createCaller({});
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t = performance.now();
      const r = await caller.audit.list({
        since: 1_700_000_002_500,
        limit: 100,
      });
      samples.push(performance.now() - t);
      expect(r.items.length).toBe(100);
    }
    expect(median(samples)).toBeLessThan(BUDGET_MS);
  });
});
