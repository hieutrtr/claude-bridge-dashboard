// P3-T5 — integration tests for `schedules.list`. Read-only over the
// vendored `schedules` table — no MCP, no audit. Same shape as the
// `loops.list` test fixture (tmp on-disk DB seeded against the live
// daemon column set).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";

import { appRouter } from "../../src/server/routers/_app";
import { resetDb } from "../../src/server/db";

// Daemon-owned `schedules` table. Mirrors the columns the daemon's
// scheduler maintains (see `claude-bridge` schema). We only pre-populate
// the columns the dashboard reads — the rest carry the daemon's
// CREATE TABLE defaults.
const SCHEMA_DDL = `
  CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    interval_minutes INTEGER,
    cron_expr TEXT,
    run_once INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    run_count INTEGER DEFAULT 0,
    consecutive_errors INTEGER DEFAULT 0,
    last_run_at TEXT,
    next_run_at TEXT,
    last_error TEXT,
    channel TEXT DEFAULT 'cli',
    channel_chat_id TEXT,
    user_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

interface SeedScheduleOpts {
  name: string;
  agentName?: string;
  prompt?: string;
  intervalMinutes?: number | null;
  cronExpr?: string | null;
  runOnce?: boolean;
  enabled?: boolean;
  runCount?: number;
  consecutiveErrors?: number;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastError?: string | null;
  channel?: string | null;
  createdAt?: string;
}

function seedSchedule(db: Database, opts: SeedScheduleOpts): number {
  const stmt = db.prepare(
    `INSERT INTO schedules
       (name, agent_name, prompt, interval_minutes, cron_expr,
        run_once, enabled, run_count, consecutive_errors,
        last_run_at, next_run_at, last_error, channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    opts.name,
    opts.agentName ?? "alpha",
    opts.prompt ?? "run the test suite",
    opts.intervalMinutes === undefined ? null : opts.intervalMinutes,
    opts.cronExpr === undefined ? null : opts.cronExpr,
    opts.runOnce ? 1 : 0,
    opts.enabled === undefined ? 1 : opts.enabled ? 1 : 0,
    opts.runCount ?? 0,
    opts.consecutiveErrors ?? 0,
    opts.lastRunAt ?? null,
    opts.nextRunAt ?? null,
    opts.lastError ?? null,
    opts.channel === undefined ? "cli" : opts.channel,
    opts.createdAt ?? "2026-05-06T00:00:00.000Z",
  );
  return Number(info.lastInsertRowid);
}

let tmpDir: string;
let dbPath: string;
let db: Database;
const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "schedules-router-test-"));
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

describe("schedules.list — empty + ordering", () => {
  it("empty DB → empty page", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out).toEqual({ items: [] });
  });

  it("orders by nextRunAt ASC; null nextRunAt drops to bottom", async () => {
    seedSchedule(db, { name: "no-next", nextRunAt: null });
    seedSchedule(db, {
      name: "soon",
      nextRunAt: "2026-05-06T09:00:00.000Z",
    });
    seedSchedule(db, {
      name: "later",
      nextRunAt: "2026-05-07T09:00:00.000Z",
    });
    seedSchedule(db, {
      name: "earlier",
      nextRunAt: "2026-05-06T08:00:00.000Z",
    });
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out.items.map((r) => r.name)).toEqual([
      "earlier",
      "soon",
      "later",
      "no-next",
    ]);
  });
});

describe("schedules.list — wire shape", () => {
  it("projects every wire column with correct types", async () => {
    const id = seedSchedule(db, {
      name: "nightly-tests",
      agentName: "betty",
      prompt: "run the full test suite at midnight",
      cronExpr: "0 0 * * *",
      intervalMinutes: null,
      runOnce: false,
      enabled: true,
      runCount: 7,
      consecutiveErrors: 1,
      lastRunAt: "2026-05-05T00:00:00.000Z",
      nextRunAt: "2026-05-06T00:00:00.000Z",
      lastError: "exit code 1",
      channel: "telegram",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out.items.length).toBe(1);
    expect(out.items[0]!).toEqual({
      id,
      name: "nightly-tests",
      agentName: "betty",
      prompt: "run the full test suite at midnight",
      cronExpr: "0 0 * * *",
      intervalMinutes: null,
      enabled: true,
      runOnce: false,
      runCount: 7,
      consecutiveErrors: 1,
      lastRunAt: "2026-05-05T00:00:00.000Z",
      nextRunAt: "2026-05-06T00:00:00.000Z",
      lastError: "exit code 1",
      channel: "telegram",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("interval-mode (legacy) row carries intervalMinutes; cronExpr=null", async () => {
    seedSchedule(db, {
      name: "every-30",
      intervalMinutes: 30,
      cronExpr: null,
      nextRunAt: "2026-05-06T08:30:00.000Z",
    });
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out.items[0]!.intervalMinutes).toBe(30);
    expect(out.items[0]!.cronExpr).toBeNull();
  });

  it("disabled row reports enabled=false", async () => {
    seedSchedule(db, { name: "paused", enabled: false });
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out.items[0]!.enabled).toBe(false);
  });

  it("nullable columns surface as null", async () => {
    seedSchedule(db, {
      name: "fresh",
      cronExpr: null,
      intervalMinutes: null,
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
    });
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out.items[0]!.cronExpr).toBeNull();
    expect(out.items[0]!.intervalMinutes).toBeNull();
    expect(out.items[0]!.lastRunAt).toBeNull();
    expect(out.items[0]!.nextRunAt).toBeNull();
    expect(out.items[0]!.lastError).toBeNull();
  });
});

describe("schedules.list — agent filter", () => {
  beforeEach(() => {
    seedSchedule(db, { name: "alpha-1", agentName: "alpha" });
    seedSchedule(db, { name: "alpha-2", agentName: "alpha" });
    seedSchedule(db, { name: "beta-1", agentName: "beta" });
  });

  it("agent filter narrows results", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({ agent: "alpha" });
    expect(out.items.map((r) => r.name).sort()).toEqual([
      "alpha-1",
      "alpha-2",
    ]);
  });

  it("unknown agent → empty page", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({ agent: "ghost" });
    expect(out.items).toEqual([]);
  });
});

describe("schedules.list — input validation", () => {
  it("rejects empty agent string", async () => {
    const caller = appRouter.createCaller({});
    let caught: TRPCError | null = null;
    try {
      await caller.schedules.list({ agent: "" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });
});
