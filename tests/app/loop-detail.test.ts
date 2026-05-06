// P3-T2 — `/loops/[loopId]` page server-component test. Mirrors
// `loops-page.test.ts`: spin up an isolated SQLite db with the
// daemon schema (loops + loop_iterations), seed rows, render the
// page module, and assert the markup.
//
// Read-only invariant: no POST / PUT / PATCH / DELETE export, no
// `"use client"` boundary at the page level. The cancel + approve
// / reject controls land in P3-T4.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import { resetDb } from "../../src/server/db";
import {
  __clearSessionSubjectForTest,
  __setSessionSubjectForTest,
} from "../../src/server/session";

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
  CREATE TABLE loop_iterations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loop_id TEXT NOT NULL,
    iteration_num INTEGER NOT NULL,
    task_id TEXT,
    prompt TEXT,
    result_summary TEXT,
    done_check_passed INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running'
  );
`;

interface SeedLoopOpts {
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
  doneWhen?: string;
  loopType?: string;
}

function seedLoop(db: Database, opts: SeedLoopOpts): void {
  db.prepare(
    `INSERT INTO loops
       (loop_id, agent, project, goal, done_when, loop_type, status,
        max_iterations, current_iteration, total_cost_usd, max_cost_usd,
        pending_approval, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.loopId,
    opts.agent ?? "alpha",
    `/tmp/${opts.agent ?? "alpha"}`,
    opts.goal ?? "fix all tests",
    opts.doneWhen ?? "manual:",
    opts.loopType ?? "bridge",
    opts.status ?? "running",
    opts.maxIterations ?? 10,
    opts.currentIteration ?? 0,
    opts.totalCostUsd ?? 0,
    opts.maxCostUsd === undefined ? null : opts.maxCostUsd,
    opts.pendingApproval ? 1 : 0,
    opts.startedAt ?? new Date().toISOString(),
  );
}

interface SeedIterOpts {
  loopId: string;
  iterationNum: number;
  taskId?: string | null;
  prompt?: string | null;
  resultSummary?: string | null;
  doneCheckPassed?: boolean;
  costUsd?: number;
  status?: string;
  finishedAt?: string | null;
}

function seedIter(db: Database, opts: SeedIterOpts): void {
  db.prepare(
    `INSERT INTO loop_iterations
       (loop_id, iteration_num, task_id, prompt, result_summary,
        done_check_passed, cost_usd, started_at, finished_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.loopId,
    opts.iterationNum,
    opts.taskId ?? null,
    opts.prompt ?? null,
    opts.resultSummary ?? null,
    opts.doneCheckPassed ? 1 : 0,
    opts.costUsd ?? 0,
    new Date(2026, 4, 6, 0, 0, opts.iterationNum).toISOString(),
    opts.finishedAt ?? null,
    opts.status ?? "running",
  );
}

let tmpDir: string;
let dbPath: string;
let db: Database;
const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "loop-detail-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const setup = new Database(dbPath);
  setup.exec(SCHEMA_DDL);
  setup.close();
  process.env.BRIDGE_DB = dbPath;
  resetDb();
  db = new Database(dbPath);
  __setSessionSubjectForTest("owner");
});

afterEach(() => {
  __clearSessionSubjectForTest();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_BRIDGE_DB === undefined) delete process.env.BRIDGE_DB;
  else process.env.BRIDGE_DB = ORIGINAL_BRIDGE_DB;
  resetDb();
});

describe("/loops/[loopId] — module surface", () => {
  it("exports a default async function", async () => {
    const mod = await import("../../app/loops/[loopId]/page");
    expect(typeof mod.default).toBe("function");
  });

  it("does NOT export POST/PUT/PATCH/DELETE (read-only invariant)", async () => {
    const mod = await import("../../app/loops/[loopId]/page");
    expect((mod as Record<string, unknown>).POST).toBeUndefined();
    expect((mod as Record<string, unknown>).PUT).toBeUndefined();
    expect((mod as Record<string, unknown>).PATCH).toBeUndefined();
    expect((mod as Record<string, unknown>).DELETE).toBeUndefined();
  });
});

describe("/loops/[loopId] — header card", () => {
  it("renders agent, status badge, goal, doneWhen, budget, iter progress", async () => {
    seedLoop(db, {
      loopId: "loop-header",
      agent: "alpha",
      status: "running",
      currentIteration: 4,
      maxIterations: 10,
      totalCostUsd: 0.5,
      maxCostUsd: 2.0,
      goal: "ship the dashboard",
      doneWhen: "command:bun test",
      loopType: "bridge",
    });
    const mod = await import("../../app/loops/[loopId]/page");
    const tree = await mod.default({
      params: Promise.resolve({ loopId: "loop-header" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("loop-header");
    expect(html).toContain("alpha");
    expect(html).toContain("Running");
    expect(html).toContain("ship the dashboard");
    expect(html).toContain("command:bun test");
    expect(html).toContain("4 / 10");
    expect(html).toContain("$0.5000 / $2.0000");
  });

  it("shows 'Waiting approval' badge when pending_approval=true", async () => {
    seedLoop(db, {
      loopId: "loop-pa",
      pendingApproval: true,
      status: "running",
    });
    const mod = await import("../../app/loops/[loopId]/page");
    const tree = await mod.default({
      params: Promise.resolve({ loopId: "loop-pa" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Waiting approval");
  });

  it("renders '—' for uncapped budget", async () => {
    seedLoop(db, {
      loopId: "loop-uncap",
      totalCostUsd: 0.25,
      maxCostUsd: null,
    });
    const mod = await import("../../app/loops/[loopId]/page");
    const tree = await mod.default({
      params: Promise.resolve({ loopId: "loop-uncap" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("$0.2500 / —");
  });
});

describe("/loops/[loopId] — iteration timeline", () => {
  it("lists each iteration with status, cost, link to task", async () => {
    seedLoop(db, { loopId: "loop-iters", currentIteration: 2 });
    seedIter(db, {
      loopId: "loop-iters",
      iterationNum: 1,
      taskId: "task-99",
      prompt: "iter 1 prompt body",
      resultSummary: "iter 1 result body",
      costUsd: 0.012,
      doneCheckPassed: false,
      status: "done",
      finishedAt: new Date(2026, 4, 6, 0, 0, 5).toISOString(),
    });
    seedIter(db, {
      loopId: "loop-iters",
      iterationNum: 2,
      taskId: "task-100",
      prompt: "iter 2 prompt body",
      resultSummary: "iter 2 result body",
      costUsd: 0.018,
      doneCheckPassed: true,
      status: "done",
      finishedAt: new Date(2026, 4, 6, 0, 0, 8).toISOString(),
    });

    const mod = await import("../../app/loops/[loopId]/page");
    const tree = await mod.default({
      params: Promise.resolve({ loopId: "loop-iters" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("#1");
    expect(html).toContain("#2");
    expect(html).toContain("$0.0120");
    expect(html).toContain("$0.0180");
    // Task cross-link.
    expect(html).toContain("/tasks/task-99");
    expect(html).toContain("/tasks/task-100");
    // doneCheckPassed=true renders a "passed" pill on iter 2.
    expect(html).toContain("passed");
    // Bodies present (collapsed by default in <details>).
    expect(html).toContain("iter 1 prompt body");
    expect(html).toContain("iter 2 result body");
  });

  it("renders the empty-state copy when no iterations recorded", async () => {
    seedLoop(db, { loopId: "loop-empty" });
    const mod = await import("../../app/loops/[loopId]/page");
    const tree = await mod.default({
      params: Promise.resolve({ loopId: "loop-empty" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("No iterations recorded yet");
  });

  it("renders the truncation banner when totalIterations > 100", async () => {
    seedLoop(db, {
      loopId: "loop-big",
      maxIterations: 200,
      currentIteration: 110,
    });
    for (let i = 1; i <= 110; i++) {
      seedIter(db, {
        loopId: "loop-big",
        iterationNum: i,
        costUsd: 0.001,
        status: "done",
      });
    }
    const mod = await import("../../app/loops/[loopId]/page");
    const tree = await mod.default({
      params: Promise.resolve({ loopId: "loop-big" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Showing the most recent 100 of 110 iterations");
  });
});

describe("/loops/[loopId] — sparkline", () => {
  it("renders a sparkline cursor when at least one iter exists", async () => {
    seedLoop(db, {
      loopId: "loop-spark",
      totalCostUsd: 0.05,
      maxCostUsd: 1.0,
    });
    seedIter(db, {
      loopId: "loop-spark",
      iterationNum: 1,
      costUsd: 0.02,
      status: "done",
    });
    seedIter(db, {
      loopId: "loop-spark",
      iterationNum: 2,
      costUsd: 0.03,
      status: "done",
    });
    const mod = await import("../../app/loops/[loopId]/page");
    const tree = await mod.default({
      params: Promise.resolve({ loopId: "loop-spark" }),
    });
    const html = renderToStaticMarkup(tree);
    // Two iterations → a polyline path is emitted.
    expect(html).toContain('data-points="2"');
    expect(html).toContain('data-testid="sparkline-cursor"');
    // Budget cap line is visible when maxCostUsd > 0.
    expect(html).toContain('data-testid="sparkline-cap"');
  });

  it("renders empty-state placeholder when no iterations", async () => {
    seedLoop(db, { loopId: "loop-spark-empty" });
    const mod = await import("../../app/loops/[loopId]/page");
    const tree = await mod.default({
      params: Promise.resolve({ loopId: "loop-spark-empty" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('data-empty="true"');
    expect(html).toContain("sparkline lights up");
  });
});

describe("/loops/[loopId] — not found", () => {
  it("calls notFound() (throws NEXT_HTTP_ERROR_FALLBACK;404) for unknown id", async () => {
    const mod = await import("../../app/loops/[loopId]/page");
    let caught: Error | null = null;
    try {
      await mod.default({ params: Promise.resolve({ loopId: "ghost" }) });
    } catch (e) {
      caught = e as Error;
    }
    // Next's notFound() throws a special error; presence is enough.
    expect(caught).not.toBeNull();
    expect(caught!.message || (caught as { digest?: string }).digest || "").toContain(
      "NEXT_HTTP_ERROR",
    );
  });

  it("calls notFound() for empty loopId", async () => {
    const mod = await import("../../app/loops/[loopId]/page");
    let caught: Error | null = null;
    try {
      await mod.default({ params: Promise.resolve({ loopId: "" }) });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
  });
});
