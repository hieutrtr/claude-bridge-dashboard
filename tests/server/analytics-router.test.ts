import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appRouter } from "../../src/server/routers/_app";
import { getSqlite, resetDb } from "../../src/server/db";

// `ENV_OWNER_USER_ID` literal — kept inline to avoid pulling in the auth
// module (which adds a JWT_SECRET requirement to this test file).
const ENV_OWNER_USER_ID = "owner";

let tmpDir: string;
let dbPath: string;
const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;

// Mirror only the columns analytics.* touches: agents (join key +
// agent.name aggregate) and tasks (cost_usd, status, completed_at,
// channel, model, session_id). Same shape as tasks-router.test.ts so the
// fixtures interop.
const SCHEMA_DDL = `
  CREATE TABLE agents (
    name TEXT NOT NULL,
    project_dir TEXT NOT NULL,
    session_id TEXT NOT NULL,
    agent_file TEXT NOT NULL,
    purpose TEXT,
    state TEXT DEFAULT 'created',
    created_at NUMERIC DEFAULT CURRENT_TIMESTAMP,
    last_task_at NUMERIC,
    total_tasks INTEGER DEFAULT 0,
    model TEXT DEFAULT 'sonnet',
    PRIMARY KEY (name, project_dir)
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    pid INTEGER,
    result_file TEXT,
    result_summary TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    num_turns INTEGER,
    exit_code INTEGER,
    error_message TEXT,
    created_at NUMERIC DEFAULT CURRENT_TIMESTAMP,
    started_at NUMERIC,
    completed_at NUMERIC,
    reported INTEGER DEFAULT 0,
    position INTEGER,
    model TEXT,
    task_type TEXT DEFAULT 'standard',
    parent_task_id INTEGER,
    channel TEXT DEFAULT 'cli',
    channel_chat_id TEXT,
    channel_message_id TEXT,
    user_id TEXT
  );
`;

interface AgentSeed {
  name: string;
  projectDir: string;
  sessionId: string;
}

interface TaskSeed {
  sessionId: string;
  status?: string;
  costUsd?: number | null;
  channel?: string | null;
  model?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  userId?: string | null;
}

// P4-T04 — `users` row seed for the costByUser tests. The migration
// runner (`runMigrations`) creates the table on first `getDb()` access,
// so the test seeds against the same handle without DDL of its own.
interface UserSeed {
  id: string;
  email: string;
  role?: "owner" | "member";
  revokedAt?: number | null;
}

function seedAgents(db: Database, rows: AgentSeed[]): void {
  const stmt = db.prepare(`
    INSERT INTO agents (name, project_dir, session_id, agent_file)
    VALUES (?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(r.name, r.projectDir, r.sessionId, `/tmp/${r.name}.md`);
  }
}

function seedTasks(db: Database, rows: TaskSeed[]): void {
  const stmt = db.prepare(`
    INSERT INTO tasks
      (session_id, prompt, status, cost_usd, channel, model,
       created_at, completed_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(
      r.sessionId,
      "do thing",
      r.status ?? "done",
      r.costUsd ?? null,
      r.channel ?? "cli",
      r.model ?? null,
      r.createdAt ?? r.completedAt ?? "2026-05-05 09:00:00",
      r.completedAt ?? null,
      r.userId ?? null,
    );
  }
}

// P4-T04 — seeds active or revoked rows in the dashboard-owned `users`
// table created lazily by `runMigrations` on first `getDb()` access.
// Caller MUST trigger that initialisation (any tRPC call already does)
// before opening the raw `Database` handle for seeding, so the table
// exists.
function seedUsers(db: Database, rows: UserSeed[]): void {
  const stmt = db.prepare(`
    INSERT INTO users (id, email, role, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(
      r.id,
      r.email,
      r.role ?? "member",
      Date.now(),
      r.revokedAt ?? null,
    );
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "analytics-router-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(SCHEMA_DDL);
  sqlite.close();
  process.env.BRIDGE_DB = dbPath;
  resetDb();
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

describe("analytics.dailyCost", () => {
  it("returns [] when no tasks exist", async () => {
    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.dailyCost({});
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("excludes rows with status != 'done'", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "s-alpha", status: "queued", costUsd: 1.0, completedAt: "2026-05-05 09:00:00" },
      { sessionId: "s-alpha", status: "running", costUsd: 2.0, completedAt: "2026-05-05 09:00:00" },
      { sessionId: "s-alpha", status: "failed", costUsd: 3.0, completedAt: "2026-05-05 09:00:00" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.dailyCost({ since: "2026-04-05" });
    expect(result).toEqual([]);
  });

  it("excludes rows with cost_usd IS NULL", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "s-alpha", status: "done", costUsd: null, completedAt: "2026-05-05 09:00:00" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.dailyCost({ since: "2026-04-05" });
    expect(result).toEqual([]);
  });

  it("aggregates per-day totals (no groupBy) in day ASC order", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "s-alpha", costUsd: 0.5, completedAt: "2026-05-03 09:00:00" },
      { sessionId: "s-alpha", costUsd: 0.25, completedAt: "2026-05-03 11:00:00" },
      { sessionId: "s-alpha", costUsd: 1.0, completedAt: "2026-05-04 09:00:00" },
      { sessionId: "s-alpha", costUsd: 2.0, completedAt: "2026-05-05 09:00:00" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.dailyCost({ since: "2026-05-01" });
    expect(result.length).toBe(3);
    expect(result[0]).toEqual({ day: "2026-05-03", key: null, costUsd: 0.75, taskCount: 2 });
    expect(result[1]).toEqual({ day: "2026-05-04", key: null, costUsd: 1.0, taskCount: 1 });
    expect(result[2]).toEqual({ day: "2026-05-05", key: null, costUsd: 2.0, taskCount: 1 });
  });

  it("clips to the default 30-day window when since omitted", async () => {
    // The window is computed against `datetime('now', '-30 days')`. We seed
    // one row "today" (well within window) and one row 60 days back
    // (outside). The newer one alone should appear.
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, completed_at)
      VALUES
        ('s-alpha', 'recent', 'done', 1.0, datetime('now', '-1 days')),
        ('s-alpha', 'old',    'done', 9.99, datetime('now', '-60 days'));
    `);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.dailyCost({});
    expect(result.length).toBe(1);
    expect(result[0]!.costUsd).toBe(1.0);
  });

  it("respects since/until bounds inclusively", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "s-alpha", costUsd: 0.1, completedAt: "2026-05-01 00:00:00" },
      { sessionId: "s-alpha", costUsd: 0.2, completedAt: "2026-05-03 12:00:00" },
      { sessionId: "s-alpha", costUsd: 0.3, completedAt: "2026-05-07 23:59:59" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.dailyCost({
      since: "2026-05-02",
      until: "2026-05-06",
    });
    expect(result.length).toBe(1);
    expect(result[0]!.day).toBe("2026-05-03");
    expect(result[0]!.costUsd).toBeCloseTo(0.2, 9);
  });

  it("groupBy: 'agent' fans out one row per (day, agentName)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
      { name: "beta", projectDir: "/tmp/beta", sessionId: "s-beta" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "s-alpha", costUsd: 0.5, completedAt: "2026-05-05 09:00:00" },
      { sessionId: "s-alpha", costUsd: 1.5, completedAt: "2026-05-05 11:00:00" },
      { sessionId: "s-beta", costUsd: 0.25, completedAt: "2026-05-05 12:00:00" },
      { sessionId: "s-beta", costUsd: 0.75, completedAt: "2026-05-06 12:00:00" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.dailyCost({
      since: "2026-05-01",
      groupBy: "agent",
    });
    expect(result.length).toBe(3);
    const buckets = result.map((r) => `${r.day}/${r.key}=${r.costUsd}`).sort();
    expect(buckets).toEqual([
      "2026-05-05/alpha=2",
      "2026-05-05/beta=0.25",
      "2026-05-06/beta=0.75",
    ]);
  });

  it("groupBy: 'channel' keys by tasks.channel", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "s-alpha", costUsd: 0.5, channel: "cli", completedAt: "2026-05-05 09:00:00" },
      { sessionId: "s-alpha", costUsd: 0.25, channel: "telegram", completedAt: "2026-05-05 10:00:00" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.dailyCost({
      since: "2026-05-01",
      groupBy: "channel",
    });
    expect(result.length).toBe(2);
    const map = Object.fromEntries(result.map((r) => [r.key, r.costUsd]));
    expect(map["cli"]).toBe(0.5);
    expect(map["telegram"]).toBe(0.25);
  });

  it("groupBy: 'model' surfaces NULL model as key: null", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "s-alpha", costUsd: 1.0, model: "opus", completedAt: "2026-05-05 09:00:00" },
      { sessionId: "s-alpha", costUsd: 0.5, model: null, completedAt: "2026-05-05 10:00:00" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.dailyCost({
      since: "2026-05-01",
      groupBy: "model",
    });
    expect(result.length).toBe(2);
    const map = new Map(result.map((r) => [r.key, r.costUsd]));
    expect(map.get("opus")).toBe(1.0);
    expect(map.get(null)).toBe(0.5);
  });

  it("returns numeric costUsd / integer taskCount (never strings)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "s-alpha", costUsd: 0.5, completedAt: "2026-05-05 09:00:00" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const [row] = await caller.analytics.dailyCost({ since: "2026-05-01" });
    expect(row).toBeDefined();
    expect(typeof row!.costUsd).toBe("number");
    expect(typeof row!.taskCount).toBe("number");
    expect(Number.isInteger(row!.taskCount)).toBe(true);
  });
});

describe("analytics.summary", () => {
  it("returns zeros when no tasks", async () => {
    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.summary({ window: "7d" });
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalTasks).toBe(0);
    expect(result.avgCostPerTask).toBe(0);
    expect(result.topAgents).toEqual([]);
    expect(result.topModels).toEqual([]);
    expect(result.window).toBe("7d");
    expect(typeof result.since).toBe("string");
  });

  it("window: '24h' excludes a task done 25h ago", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, completed_at)
      VALUES
        ('s-alpha', 'fresh', 'done', 1.0, datetime('now', '-2 hours')),
        ('s-alpha', 'stale', 'done', 5.0, datetime('now', '-25 hours'));
    `);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.summary({ window: "24h" });
    expect(result.totalTasks).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(1.0, 9);
  });

  it("topAgents ordered by costUsd DESC and capped at 5", async () => {
    const sqlite = new Database(dbPath);
    const names = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    seedAgents(
      sqlite,
      names.map((n) => ({ name: n, projectDir: `/tmp/${n}`, sessionId: `s-${n}` })),
    );
    seedTasks(
      sqlite,
      names.map((n, i) => ({
        sessionId: `s-${n}`,
        costUsd: (i + 1) * 1.0,
        completedAt: "2026-05-05 09:00:00",
      })),
    );
    // Use a far-back since so the seeded fixed dates fall in window.
    // (We override summary to compute since per window argument; for the
    // test we rely on '30d' covering the seeded date.)
    sqlite.exec(`UPDATE tasks SET completed_at = datetime('now', '-1 hours');`);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.summary({ window: "30d" });
    expect(result.topAgents.length).toBe(5);
    const ordered = result.topAgents.map((a) => a.agentName);
    expect(ordered).toEqual(["a7", "a6", "a5", "a4", "a3"]);
    expect(result.topAgents[0]!.costUsd).toBe(7.0);
  });

  it("topAgents preserves null agentName for orphan tasks", async () => {
    const sqlite = new Database(dbPath);
    // No agents seeded — every task is an orphan (no matching session_id
    // in agents table).
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, completed_at)
      VALUES
        ('orphan-session', 'task', 'done', 4.0, datetime('now', '-1 hours'));
    `);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.summary({ window: "7d" });
    expect(result.topAgents.length).toBe(1);
    expect(result.topAgents[0]!.agentName).toBeNull();
    expect(result.topAgents[0]!.costUsd).toBe(4.0);
  });

  it("topModels ordered DESC and surfaces null model", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, model, completed_at)
      VALUES
        ('s-alpha', 't', 'done', 1.0, 'opus', datetime('now', '-1 hours')),
        ('s-alpha', 't', 'done', 5.0, 'opus', datetime('now', '-2 hours')),
        ('s-alpha', 't', 'done', 0.5, 'sonnet', datetime('now', '-3 hours')),
        ('s-alpha', 't', 'done', 0.25, NULL, datetime('now', '-4 hours'));
    `);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const result = await caller.analytics.summary({ window: "7d" });
    expect(result.topModels.length).toBe(3);
    expect(result.topModels[0]!.model).toBe("opus");
    expect(result.topModels[0]!.costUsd).toBe(6.0);
    expect(result.topModels[1]!.model).toBe("sonnet");
    const lastModel = result.topModels[2]!;
    expect(lastModel.model).toBeNull();
    expect(lastModel.costUsd).toBe(0.25);
  });

  it("avgCostPerTask is total/count with no NaN on empty input", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, completed_at)
      VALUES
        ('s-alpha', 't', 'done', 1.0, datetime('now', '-1 hours')),
        ('s-alpha', 't', 'done', 2.0, datetime('now', '-2 hours')),
        ('s-alpha', 't', 'done', 3.0, datetime('now', '-3 hours'));
    `);
    sqlite.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const populated = await caller.analytics.summary({ window: "7d" });
    expect(populated.totalTasks).toBe(3);
    expect(populated.totalCostUsd).toBeCloseTo(6.0, 9);
    expect(populated.avgCostPerTask).toBeCloseTo(2.0, 9);

    // Truncate and verify the empty-input branch doesn't regress.
    const sqlite2 = new Database(dbPath);
    sqlite2.exec("DELETE FROM tasks;");
    sqlite2.close();
    resetDb();

    const empty = await caller.analytics.summary({ window: "7d" });
    expect(empty.avgCostPerTask).toBe(0);
    expect(Number.isNaN(empty.avgCostPerTask)).toBe(false);
  });
});

describe("analytics.costByUser", () => {
  // Cross-cutting helper: trigger migrations on the cached handle so
  // the dashboard-owned `users` table exists before we try to seed it.
  // First `getSqlite()` call after `resetDb()` opens the DB and runs
  // `runMigrations` (idempotent, IF-NOT-EXISTS guarded).
  function ensureMigrated(): Database {
    return getSqlite();
  }

  it("owner sees [] on a fresh DB", async () => {
    const caller = appRouter.createCaller({
      userId: ENV_OWNER_USER_ID,
    });
    const result = await caller.analytics.costByUser({ window: "30d" });
    expect(result.rows).toEqual([]);
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalTasks).toBe(0);
    expect(result.callerRole).toBe("owner");
    expect(result.selfRow).toBeNull();
    expect(result.window).toBe("30d");
    expect(typeof result.since).toBe("string");
  });

  it("owner totals match analytics.summary for the same window", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, user_id, completed_at)
      VALUES
        ('s-alpha', 't', 'done', 1.5,  'u-1', datetime('now', '-1 hours')),
        ('s-alpha', 't', 'done', 2.5,  'u-2', datetime('now', '-2 hours')),
        ('s-alpha', 't', 'done', 0.25, NULL,  datetime('now', '-3 hours'));
    `);
    sqlite.close();

    ensureMigrated();
    const cached = getSqlite();
    seedUsers(cached, [
      { id: "u-1", email: "alice@example.com", role: "member" },
      { id: "u-2", email: "bob@example.com", role: "member" },
    ]);

    const caller = appRouter.createCaller({
      userId: ENV_OWNER_USER_ID,
    });
    const summary = await caller.analytics.summary({ window: "7d" });
    const byUser = await caller.analytics.costByUser({ window: "7d" });

    expect(byUser.totalCostUsd).toBeCloseTo(summary.totalCostUsd, 9);
    expect(byUser.totalTasks).toBe(summary.totalTasks);
    expect(byUser.totalTasks).toBe(3);
  });

  it("owner sees per-user buckets sorted by costUsd DESC", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, user_id, completed_at)
      VALUES
        ('s-alpha', 't', 'done', 4.0, 'u-bob',   datetime('now', '-1 hours')),
        ('s-alpha', 't', 'done', 5.0, 'u-bob',   datetime('now', '-2 hours')),
        ('s-alpha', 't', 'done', 3.0, 'u-alice', datetime('now', '-3 hours'));
    `);
    sqlite.close();

    ensureMigrated();
    const cached = getSqlite();
    seedUsers(cached, [
      { id: "u-alice", email: "alice@example.com", role: "member" },
      { id: "u-bob", email: "bob@example.com", role: "member" },
    ]);

    const caller = appRouter.createCaller({
      userId: ENV_OWNER_USER_ID,
    });
    const result = await caller.analytics.costByUser({ window: "7d" });
    expect(result.rows.length).toBe(2);
    expect(result.rows[0]!.userId).toBe("u-bob");
    expect(result.rows[0]!.email).toBe("bob@example.com");
    expect(result.rows[0]!.costUsd).toBeCloseTo(9.0, 9);
    expect(result.rows[0]!.taskCount).toBe(2);
    expect(result.rows[1]!.userId).toBe("u-alice");
    expect(result.rows[1]!.costUsd).toBeCloseTo(3.0, 9);
  });

  it("owner buckets tasks.user_id IS NULL into (unattributed)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, user_id, completed_at)
      VALUES
        ('s-alpha', 't', 'done', 2.0, 'u-alice', datetime('now', '-1 hours')),
        ('s-alpha', 't', 'done', 0.5, NULL,      datetime('now', '-2 hours'));
    `);
    sqlite.close();

    ensureMigrated();
    seedUsers(getSqlite(), [
      { id: "u-alice", email: "alice@example.com", role: "member" },
    ]);

    const caller = appRouter.createCaller({
      userId: ENV_OWNER_USER_ID,
    });
    const result = await caller.analytics.costByUser({ window: "7d" });
    expect(result.rows.length).toBe(2);
    const unattributed = result.rows.find((r) => r.userId === null);
    expect(unattributed).toBeDefined();
    expect(unattributed!.email).toBeNull();
    expect(unattributed!.costUsd).toBeCloseTo(0.5, 9);
    expect(unattributed!.taskCount).toBe(1);
  });

  it("owner buckets unknown user_id refs into (unattributed)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, user_id, completed_at)
      VALUES
        ('s-alpha', 't', 'done', 1.0, 'u-known',   datetime('now', '-1 hours')),
        ('s-alpha', 't', 'done', 0.7, 'u-unknown', datetime('now', '-2 hours'));
    `);
    sqlite.close();

    ensureMigrated();
    seedUsers(getSqlite(), [
      { id: "u-known", email: "known@example.com", role: "member" },
    ]);

    const caller = appRouter.createCaller({
      userId: ENV_OWNER_USER_ID,
    });
    const result = await caller.analytics.costByUser({ window: "7d" });
    const unattributed = result.rows.find((r) => r.userId === null);
    expect(unattributed).toBeDefined();
    expect(unattributed!.costUsd).toBeCloseTo(0.7, 9);
    expect(unattributed!.taskCount).toBe(1);
  });

  it("owner buckets revoked users into (unattributed) (no email leak)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, user_id, completed_at)
      VALUES
        ('s-alpha', 't', 'done', 1.0, 'u-active',  datetime('now', '-1 hours')),
        ('s-alpha', 't', 'done', 0.4, 'u-revoked', datetime('now', '-2 hours'));
    `);
    sqlite.close();

    ensureMigrated();
    seedUsers(getSqlite(), [
      { id: "u-active", email: "active@example.com", role: "member" },
      {
        id: "u-revoked",
        email: "revoked@example.com",
        role: "member",
        revokedAt: Date.now(),
      },
    ]);

    const caller = appRouter.createCaller({
      userId: ENV_OWNER_USER_ID,
    });
    const result = await caller.analytics.costByUser({ window: "7d" });
    expect(result.rows.length).toBe(2);
    const emails = result.rows.map((r) => r.email);
    expect(emails).not.toContain("revoked@example.com");
    const unattributed = result.rows.find((r) => r.userId === null);
    expect(unattributed!.costUsd).toBeCloseTo(0.4, 9);
  });

  it("member callers see ONLY their own row (other users invisible)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, user_id, completed_at)
      VALUES
        ('s-alpha', 't', 'done', 5.0, 'u-other', datetime('now', '-1 hours')),
        ('s-alpha', 't', 'done', 1.0, 'u-self',  datetime('now', '-2 hours')),
        ('s-alpha', 't', 'done', 0.5, 'u-self',  datetime('now', '-3 hours'));
    `);
    sqlite.close();

    ensureMigrated();
    seedUsers(getSqlite(), [
      { id: "u-self", email: "self@example.com", role: "member" },
      { id: "u-other", email: "other@example.com", role: "member" },
    ]);

    const caller = appRouter.createCaller({ userId: "u-self" });
    const result = await caller.analytics.costByUser({ window: "7d" });
    expect(result.callerRole).toBe("member");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.userId).toBe("u-self");
    expect(result.rows[0]!.email).toBe("self@example.com");
    expect(result.rows[0]!.costUsd).toBeCloseTo(1.5, 9);
    expect(result.rows[0]!.shareOfTotal).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(1.5, 9);
    expect(result.selfRow).toEqual(result.rows[0]!);
  });

  it("member zero-fill: empty rows but selfRow with costUsd 0", async () => {
    ensureMigrated();
    seedUsers(getSqlite(), [
      { id: "u-self", email: "self@example.com", role: "member" },
    ]);

    const caller = appRouter.createCaller({ userId: "u-self" });
    const result = await caller.analytics.costByUser({ window: "7d" });
    expect(result.callerRole).toBe("member");
    expect(result.rows).toEqual([]);
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalTasks).toBe(0);
    expect(result.selfRow).toEqual({
      userId: "u-self",
      email: "self@example.com",
      costUsd: 0,
      taskCount: 0,
      shareOfTotal: 0,
    });
  });

  it("shareOfTotal sums to 1 (with spend) and is 0 on empty (no NaN)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "s-alpha" },
    ]);
    sqlite.exec(`
      INSERT INTO tasks (session_id, prompt, status, cost_usd, user_id, completed_at)
      VALUES
        ('s-alpha', 't', 'done', 3.0, 'u-a', datetime('now', '-1 hours')),
        ('s-alpha', 't', 'done', 1.0, 'u-b', datetime('now', '-2 hours'));
    `);
    sqlite.close();

    ensureMigrated();
    seedUsers(getSqlite(), [
      { id: "u-a", email: "a@example.com", role: "member" },
      { id: "u-b", email: "b@example.com", role: "member" },
    ]);

    const caller = appRouter.createCaller({
      userId: ENV_OWNER_USER_ID,
    });
    const populated = await caller.analytics.costByUser({ window: "7d" });
    const sum = populated.rows.reduce((acc, r) => acc + r.shareOfTotal, 0);
    expect(sum).toBeCloseTo(1.0, 9);

    // Empty branch — no spend ⇒ no NaN. Re-use the existing seeded
    // users; only the tasks table needs truncating.
    const sqlite2 = new Database(dbPath);
    sqlite2.exec("DELETE FROM tasks;");
    sqlite2.close();
    resetDb();

    const empty = await caller.analytics.costByUser({ window: "7d" });
    expect(empty.totalCostUsd).toBe(0);
    for (const row of empty.rows) {
      expect(row.shareOfTotal).toBe(0);
      expect(Number.isNaN(row.shareOfTotal)).toBe(false);
    }
  });
});
