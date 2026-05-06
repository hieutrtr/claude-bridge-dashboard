// P3-T1 — `/loops` page server component test. Mirrors
// `cost-page.test.ts`: spin up an isolated SQLite db with the daemon
// schema, seed a few `loops` rows, render the page, assert the markup.
//
// Read-only invariant: `/loops` is a server-rendered list — no POST /
// PUT / PATCH / DELETE export, no `"use client"` boundary at the
// page level.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import { resetDb } from "../../src/server/db";

const SCHEMA_DDL = `
  CREATE TABLE loops (
    loop_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    project TEXT NOT NULL,
    goal TEXT NOT NULL,
    done_when TEXT NOT NULL,
    loop_type TEXT NOT NULL DEFAULT 'bridge',
    status TEXT NOT NULL DEFAULT 'running',
    max_iterations INTEGER NOT NULL DEFAULT 10,
    max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
    current_iteration INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    max_cost_usd REAL,
    pending_approval INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    finish_reason TEXT,
    current_task_id TEXT,
    channel TEXT,
    channel_chat_id TEXT,
    user_id TEXT,
    plan TEXT,
    plan_enabled INTEGER NOT NULL DEFAULT 0,
    pass_threshold INTEGER NOT NULL DEFAULT 1,
    consecutive_passes INTEGER NOT NULL DEFAULT 0
  );
`;

interface SeedOpts {
  loopId: string;
  agent?: string;
  status?: string;
  pendingApproval?: boolean;
  currentIteration?: number;
  maxIterations?: number;
  totalCostUsd?: number;
  maxCostUsd?: number | null;
  startedAt?: string;
  goal?: string;
}

function seed(db: Database, opts: SeedOpts): void {
  db.prepare(
    `INSERT INTO loops
       (loop_id, agent, project, goal, done_when, status,
        max_iterations, current_iteration, total_cost_usd, max_cost_usd,
        pending_approval, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.loopId,
    opts.agent ?? "alpha",
    `/tmp/${opts.agent ?? "alpha"}`,
    opts.goal ?? "fix all tests",
    "manual:",
    opts.status ?? "running",
    opts.maxIterations ?? 10,
    opts.currentIteration ?? 0,
    opts.totalCostUsd ?? 0,
    opts.maxCostUsd === undefined ? null : opts.maxCostUsd,
    opts.pendingApproval ? 1 : 0,
    opts.startedAt ?? new Date().toISOString(),
  );
}

let tmpDir: string;
let dbPath: string;
let db: Database;
const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "loops-page-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const setup = new Database(dbPath);
  setup.exec(SCHEMA_DDL);
  setup.close();
  process.env.BRIDGE_DB = dbPath;
  resetDb();
  db = new Database(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_BRIDGE_DB === undefined) {
    delete process.env.BRIDGE_DB;
  } else {
    process.env.BRIDGE_DB = ORIGINAL_BRIDGE_DB;
  }
  resetDb();
});

describe("/loops page — module surface", () => {
  it("exports a default async function", async () => {
    const mod = await import("../../app/loops/page");
    expect(typeof mod.default).toBe("function");
  });

  it("does NOT export POST/PUT/PATCH/DELETE (read-only invariant)", async () => {
    const mod = await import("../../app/loops/page");
    expect((mod as Record<string, unknown>).POST).toBeUndefined();
    expect((mod as Record<string, unknown>).PUT).toBeUndefined();
    expect((mod as Record<string, unknown>).PATCH).toBeUndefined();
    expect((mod as Record<string, unknown>).DELETE).toBeUndefined();
  });
});

describe("/loops page — empty state", () => {
  it("renders empty-state copy when no loops exist (no filters)", async () => {
    const mod = await import("../../app/loops/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Loops");
    // Empty-state copy from <LoopTable>.
    expect(html).toContain("No goal loops have been started");
    expect(html).toContain("bridge_loop");
  });

  it("renders filtered empty-state when filters yield zero rows", async () => {
    seed(db, { loopId: "loop-1", agent: "alpha", status: "running" });
    const mod = await import("../../app/loops/page");
    const tree = await mod.default({
      searchParams: Promise.resolve({ agent: "ghost" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("No loops match the current filters");
  });
});

describe("/loops page — populated table", () => {
  it("renders one row per loop with status badge + budget + iter", async () => {
    seed(db, {
      loopId: "loop-aaaa-bbbb",
      agent: "alpha",
      status: "running",
      currentIteration: 3,
      maxIterations: 8,
      totalCostUsd: 0.1234,
      maxCostUsd: 5.0,
    });
    const mod = await import("../../app/loops/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("loop-aaa"); // truncated id
    expect(html).toContain("alpha");
    expect(html).toContain("Running");
    expect(html).toContain("3 / 8");
    expect(html).toContain("$0.1234");
    expect(html).toContain("$5.0000");
  });

  it("renders 'Waiting approval' badge when pending_approval=true", async () => {
    seed(db, {
      loopId: "loop-pa",
      agent: "beta",
      status: "running", // daemon keeps status running while waiting
      pendingApproval: true,
    });
    const mod = await import("../../app/loops/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Waiting approval");
  });

  it("renders '—' for uncapped budget", async () => {
    seed(db, {
      loopId: "loop-uncap",
      totalCostUsd: 0.5,
      maxCostUsd: null,
    });
    const mod = await import("../../app/loops/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("$0.5000 / —");
  });
});

describe("/loops page — filter URL → status mapping", () => {
  beforeEach(() => {
    seed(db, {
      loopId: "loop-running",
      agent: "alpha",
      status: "running",
      pendingApproval: false,
      startedAt: "2026-05-01T10:00:00.000Z",
    });
    seed(db, {
      loopId: "loop-pa",
      agent: "alpha",
      status: "running",
      pendingApproval: true,
      startedAt: "2026-05-02T10:00:00.000Z",
    });
    seed(db, {
      loopId: "loop-done",
      agent: "alpha",
      status: "done",
      pendingApproval: false,
      startedAt: "2026-05-03T10:00:00.000Z",
    });
  });

  it("?status=waiting_approval surfaces only pa=true loops", async () => {
    const mod = await import("../../app/loops/page");
    const tree = await mod.default({
      searchParams: Promise.resolve({ status: "waiting_approval" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("loop-pa");
    expect(html).not.toContain("loop-running");
    expect(html).not.toContain("loop-done");
  });

  it("?status=done surfaces only finished loops", async () => {
    const mod = await import("../../app/loops/page");
    const tree = await mod.default({
      searchParams: Promise.resolve({ status: "done" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("loop-done");
    expect(html).not.toContain("loop-running");
    expect(html).not.toContain("loop-pa");
  });

  it("filter strip default values reflect URL", async () => {
    const mod = await import("../../app/loops/page");
    const tree = await mod.default({
      searchParams: Promise.resolve({ status: "running", agent: "alpha" }),
    });
    const html = renderToStaticMarkup(tree);
    // Selected option is `selected` in the rendered <option>.
    expect(html).toMatch(/<option[^>]*value="running"[^>]*selected/);
    // Agent input echoes the URL value.
    expect(html).toMatch(/name="agent"[^>]*value="alpha"/);
  });
});

describe("/loops page — privacy", () => {
  it("does NOT echo the loop's `goal` text into the rendered HTML", async () => {
    seed(db, {
      loopId: "loop-leak",
      agent: "alpha",
      goal: "SECRET_GOAL_TEXT_DO_NOT_LEAK",
    });
    const mod = await import("../../app/loops/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).not.toContain("SECRET_GOAL_TEXT_DO_NOT_LEAK");
  });
});
