import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appRouter } from "../../src/server/routers/_app";
import { resetDb } from "../../src/server/db";

let tmpDir: string;
let dbPath: string;
const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;
const ORIGINAL_CLAUDE_HOME = process.env.CLAUDE_HOME;

// Schema mirrors src/db/schema.ts for the two tables tasks.listByAgent
// touches: agents (joined to scope by name) and tasks. We only carry the
// columns the router projects + the join keys.
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
  prompt?: string;
  status?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
  channel?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
}

// T06 — tasks.get exercises columns the listing tests don't touch
// (`result_summary`, `num_turns`, `exit_code`, `model`, `task_type`,
// `parent_task_id`, `error_message`, `started_at`, `channel_chat_id`,
// `channel_message_id`). A focused seed helper keeps the query under test
// isolated.
interface TaskDetailSeed extends TaskSeed {
  resultSummary?: string | null;
  numTurns?: number | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  model?: string | null;
  taskType?: string | null;
  parentTaskId?: number | null;
  startedAt?: string | null;
  channelChatId?: string | null;
  channelMessageId?: string | null;
  resultFile?: string | null;
  pid?: number | null;
  userId?: string | null;
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
      (session_id, prompt, status, cost_usd, duration_ms,
       channel, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(
      r.sessionId,
      r.prompt ?? "do thing",
      r.status ?? "done",
      r.costUsd ?? null,
      r.durationMs ?? null,
      r.channel ?? "cli",
      r.createdAt ?? "2026-05-05 09:00:00",
      r.completedAt ?? null,
    );
  }
}

function seedTaskDetail(db: Database, row: TaskDetailSeed): number {
  const stmt = db.prepare(`
    INSERT INTO tasks
      (session_id, prompt, status, pid, result_file, result_summary,
       cost_usd, duration_ms, num_turns, exit_code, error_message,
       created_at, started_at, completed_at, model, task_type,
       parent_task_id, channel, channel_chat_id, channel_message_id, user_id)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    row.sessionId,
    row.prompt ?? "do thing",
    row.status ?? "done",
    row.pid ?? null,
    row.resultFile ?? null,
    row.resultSummary ?? null,
    row.costUsd ?? null,
    row.durationMs ?? null,
    row.numTurns ?? null,
    row.exitCode ?? null,
    row.errorMessage ?? null,
    row.createdAt ?? "2026-05-05 09:00:00",
    row.startedAt ?? null,
    row.completedAt ?? null,
    row.model ?? null,
    row.taskType ?? "standard",
    row.parentTaskId ?? null,
    row.channel ?? "cli",
    row.channelChatId ?? null,
    row.channelMessageId ?? null,
    row.userId ?? null,
  );
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tasks-router-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(SCHEMA_DDL);
  sqlite.close();
  process.env.BRIDGE_DB = dbPath;
  // T07 — point CLAUDE_HOME at the same temp dir so tests can
  // materialise a JSONL fixture under <home>/projects/<slug>/. The
  // tasks.transcript procedure picks this up via env.
  process.env.CLAUDE_HOME = tmpDir;
  resetDb();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_BRIDGE_DB === undefined) {
    delete process.env.BRIDGE_DB;
  } else {
    process.env.BRIDGE_DB = ORIGINAL_BRIDGE_DB;
  }
  if (ORIGINAL_CLAUDE_HOME === undefined) {
    delete process.env.CLAUDE_HOME;
  } else {
    process.env.CLAUDE_HOME = ORIGINAL_CLAUDE_HOME;
  }
  resetDb();
});

// T07 — write a JSONL fixture at <CLAUDE_HOME>/projects/<slug>/<sessionId>.jsonl.
// `slug` is the project_dir flipped through `projectSlug` (every '/' → '-').
function writeTranscriptFixture(
  home: string,
  projectDir: string,
  sessionId: string,
  lines: string[],
): string {
  const slug = projectDir.replace(/\//g, "-");
  const dir = join(home, "projects", slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.join("\n"));
  return path;
}

describe("tasks.listByAgent", () => {
  it("returns empty page for an unknown agent", async () => {
    const caller = appRouter.createCaller({});
    const result = await caller.tasks.listByAgent({ agentName: "ghost" });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("returns empty page when the agent has zero tasks", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.tasks.listByAgent({ agentName: "alpha" });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("returns tasks ordered by id DESC (most recent first)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "alpha-s", prompt: "first" },
      { sessionId: "alpha-s", prompt: "second" },
      { sessionId: "alpha-s", prompt: "third" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.tasks.listByAgent({ agentName: "alpha" });
    expect(result.items.map((t) => t.prompt)).toEqual(["third", "second", "first"]);
    const ids = result.items.map((t) => t.id);
    expect(ids[0]! > ids[1]!).toBe(true);
    expect(ids[1]! > ids[2]!).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it("default limit caps at 50 and exposes nextCursor when more remain", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(
      sqlite,
      Array.from({ length: 60 }, (_, i) => ({
        sessionId: "alpha-s",
        prompt: `task-${i}`,
      })),
    );
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.tasks.listByAgent({ agentName: "alpha" });
    expect(result.items.length).toBe(50);
    const lowestId = result.items[result.items.length - 1]!.id;
    expect(result.nextCursor).toBe(lowestId);
  });

  it("nextCursor is null when fewer than `limit` rows remain", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(
      sqlite,
      Array.from({ length: 5 }, (_, i) => ({
        sessionId: "alpha-s",
        prompt: `task-${i}`,
      })),
    );
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.tasks.listByAgent({
      agentName: "alpha",
      limit: 50,
    });
    expect(result.items.length).toBe(5);
    expect(result.nextCursor).toBeNull();
  });

  it("cursor filter returns only tasks with id < cursor", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(
      sqlite,
      Array.from({ length: 6 }, (_, i) => ({
        sessionId: "alpha-s",
        prompt: `task-${i}`,
      })),
    );
    sqlite.close();

    const caller = appRouter.createCaller({});
    const page1 = await caller.tasks.listByAgent({
      agentName: "alpha",
      limit: 3,
    });
    expect(page1.items.length).toBe(3);
    expect(page1.nextCursor).toBe(page1.items[2]!.id);

    const page2 = await caller.tasks.listByAgent({
      agentName: "alpha",
      limit: 3,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.length).toBe(3);
    for (const t of page2.items) {
      expect(t.id < page1.nextCursor!).toBe(true);
    }
    // Page2 should hold the three lowest ids — no overlap with page1.
    const overlapping = page1.items.filter((p1) =>
      page2.items.some((p2) => p2.id === p1.id),
    );
    expect(overlapping.length).toBe(0);
  });

  it("rejects limit > 100 and limit < 1", async () => {
    const caller = appRouter.createCaller({});
    let oversize = false;
    try {
      await caller.tasks.listByAgent({ agentName: "alpha", limit: 101 });
    } catch {
      oversize = true;
    }
    expect(oversize).toBe(true);

    let undersize = false;
    try {
      await caller.tasks.listByAgent({ agentName: "alpha", limit: 0 });
    } catch {
      undersize = true;
    }
    expect(undersize).toBe(true);
  });

  it("excludes tasks for other agents (cross-agent isolation)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
      { name: "beta", projectDir: "/tmp/beta", sessionId: "beta-s" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "alpha-s", prompt: "alpha-1" },
      { sessionId: "beta-s", prompt: "beta-1" },
      { sessionId: "alpha-s", prompt: "alpha-2" },
      { sessionId: "beta-s", prompt: "beta-2" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const alphaPage = await caller.tasks.listByAgent({ agentName: "alpha" });
    expect(alphaPage.items.map((t) => t.prompt).sort()).toEqual([
      "alpha-1",
      "alpha-2",
    ]);
    const betaPage = await caller.tasks.listByAgent({ agentName: "beta" });
    expect(betaPage.items.map((t) => t.prompt).sort()).toEqual([
      "beta-1",
      "beta-2",
    ]);
  });

  it("projects only the eight DTO fields", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(sqlite, [
      {
        sessionId: "alpha-s",
        prompt: "P",
        status: "done",
        costUsd: 0.01,
        durationMs: 1234,
        channel: "telegram",
        createdAt: "2026-05-05 09:00:00",
        completedAt: "2026-05-05 09:00:05",
      },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items } = await caller.tasks.listByAgent({ agentName: "alpha" });
    expect(items.length).toBe(1);
    const keys = Object.keys(items[0]!).sort();
    expect(keys).toEqual([
      "channel",
      "completedAt",
      "costUsd",
      "createdAt",
      "durationMs",
      "id",
      "prompt",
      "status",
    ]);
    const t = items[0]!;
    expect(typeof t.id).toBe("number");
    expect(t.prompt).toBe("P");
    expect(t.status).toBe("done");
    expect(t.costUsd).toBe(0.01);
    expect(t.durationMs).toBe(1234);
    expect(t.channel).toBe("telegram");
    expect(t.createdAt).toBe("2026-05-05 09:00:00");
    expect(t.completedAt).toBe("2026-05-05 09:00:05");
  });

  it("includes tasks from any session that maps to the agent name", async () => {
    // Same name in two project dirs means two different session_id values.
    // listByAgent should return tasks across both — duplicate-name rescue.
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "shared", projectDir: "/tmp/a", sessionId: "shared-a" },
      { name: "shared", projectDir: "/tmp/b", sessionId: "shared-b" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "shared-a", prompt: "from-a" },
      { sessionId: "shared-b", prompt: "from-b" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items } = await caller.tasks.listByAgent({ agentName: "shared" });
    expect(items.map((t) => t.prompt).sort()).toEqual(["from-a", "from-b"]);
  });
});

describe("tasks.list (global)", () => {
  it("returns empty page when DB has no tasks", async () => {
    const caller = appRouter.createCaller({});
    const result = await caller.tasks.list({});
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("returns rows ordered by id DESC with agentName populated", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
      { name: "beta", projectDir: "/tmp/beta", sessionId: "beta-s" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "alpha-s", prompt: "a-1" },
      { sessionId: "beta-s", prompt: "b-1" },
      { sessionId: "alpha-s", prompt: "a-2" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items } = await caller.tasks.list({});
    expect(items.length).toBe(3);
    // Most recent first.
    expect(items.map((t) => t.prompt)).toEqual(["a-2", "b-1", "a-1"]);
    // Each row carries the right agent name.
    const byPrompt = new Map(items.map((t) => [t.prompt, t.agentName]));
    expect(byPrompt.get("a-1")).toBe("alpha");
    expect(byPrompt.get("a-2")).toBe("alpha");
    expect(byPrompt.get("b-1")).toBe("beta");
  });

  it("filters by status (exact match)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "alpha-s", prompt: "p1", status: "running" },
      { sessionId: "alpha-s", prompt: "p2", status: "done" },
      { sessionId: "alpha-s", prompt: "p3", status: "running" },
      { sessionId: "alpha-s", prompt: "p4", status: "failed" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items } = await caller.tasks.list({ status: "running" });
    expect(items.map((t) => t.prompt).sort()).toEqual(["p1", "p3"]);
  });

  it("filters by channel (exact match)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "alpha-s", prompt: "p1", channel: "cli" },
      { sessionId: "alpha-s", prompt: "p2", channel: "telegram" },
      { sessionId: "alpha-s", prompt: "p3", channel: "telegram" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items } = await caller.tasks.list({ channel: "telegram" });
    expect(items.map((t) => t.prompt).sort()).toEqual(["p2", "p3"]);
  });

  it("filters by agentName via agents → session_id resolution", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
      { name: "beta", projectDir: "/tmp/beta", sessionId: "beta-s" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "alpha-s", prompt: "a-1" },
      { sessionId: "beta-s", prompt: "b-1" },
      { sessionId: "alpha-s", prompt: "a-2" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items } = await caller.tasks.list({ agentName: "alpha" });
    expect(items.map((t) => t.prompt).sort()).toEqual(["a-1", "a-2"]);
    for (const t of items) {
      expect(t.agentName).toBe("alpha");
    }
  });

  it("returns empty page when agentName filter matches no agent (no throw)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(sqlite, [{ sessionId: "alpha-s", prompt: "p1" }]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.tasks.list({ agentName: "ghost" });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("filters by since (created_at >= since)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "alpha-s", prompt: "old", createdAt: "2026-01-01 00:00:00" },
      { sessionId: "alpha-s", prompt: "mid", createdAt: "2026-03-15 12:00:00" },
      { sessionId: "alpha-s", prompt: "new", createdAt: "2026-05-05 09:00:00" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items } = await caller.tasks.list({ since: "2026-03-01 00:00:00" });
    expect(items.map((t) => t.prompt).sort()).toEqual(["mid", "new"]);
  });

  it("filters by until (created_at <= until)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(sqlite, [
      { sessionId: "alpha-s", prompt: "old", createdAt: "2026-01-01 00:00:00" },
      { sessionId: "alpha-s", prompt: "mid", createdAt: "2026-03-15 12:00:00" },
      { sessionId: "alpha-s", prompt: "new", createdAt: "2026-05-05 09:00:00" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items } = await caller.tasks.list({ until: "2026-03-31 23:59:59" });
    expect(items.map((t) => t.prompt).sort()).toEqual(["mid", "old"]);
  });

  it("ANDs combined filters (status + channel + date range)", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(sqlite, [
      {
        sessionId: "alpha-s",
        prompt: "match",
        status: "done",
        channel: "telegram",
        createdAt: "2026-04-10 10:00:00",
      },
      {
        sessionId: "alpha-s",
        prompt: "wrong-status",
        status: "running",
        channel: "telegram",
        createdAt: "2026-04-10 10:00:00",
      },
      {
        sessionId: "alpha-s",
        prompt: "wrong-channel",
        status: "done",
        channel: "cli",
        createdAt: "2026-04-10 10:00:00",
      },
      {
        sessionId: "alpha-s",
        prompt: "out-of-range",
        status: "done",
        channel: "telegram",
        createdAt: "2026-01-01 00:00:00",
      },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items } = await caller.tasks.list({
      status: "done",
      channel: "telegram",
      since: "2026-04-01 00:00:00",
      until: "2026-04-30 23:59:59",
    });
    expect(items.map((t) => t.prompt)).toEqual(["match"]);
  });

  it("default limit is 50 and exposes nextCursor when more remain", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(
      sqlite,
      Array.from({ length: 60 }, (_, i) => ({
        sessionId: "alpha-s",
        prompt: `p-${i}`,
      })),
    );
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items, nextCursor } = await caller.tasks.list({});
    expect(items.length).toBe(50);
    expect(nextCursor).toBe(items[items.length - 1]!.id);
  });

  it("nextCursor is null when fewer than `limit` rows match", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(
      sqlite,
      Array.from({ length: 5 }, (_, i) => ({
        sessionId: "alpha-s",
        prompt: `p-${i}`,
      })),
    );
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items, nextCursor } = await caller.tasks.list({});
    expect(items.length).toBe(5);
    expect(nextCursor).toBeNull();
  });

  it("cursor returns only rows with id < cursor and no overlap", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(
      sqlite,
      Array.from({ length: 6 }, (_, i) => ({
        sessionId: "alpha-s",
        prompt: `p-${i}`,
      })),
    );
    sqlite.close();

    const caller = appRouter.createCaller({});
    const page1 = await caller.tasks.list({ limit: 3 });
    expect(page1.items.length).toBe(3);
    expect(page1.nextCursor).toBe(page1.items[2]!.id);

    const page2 = await caller.tasks.list({ limit: 3, cursor: page1.nextCursor! });
    expect(page2.items.length).toBe(3);
    for (const t of page2.items) {
      expect(t.id < page1.nextCursor!).toBe(true);
    }
    const overlapping = page1.items.filter((p1) =>
      page2.items.some((p2) => p2.id === p1.id),
    );
    expect(overlapping.length).toBe(0);
  });

  it("rejects limit > 100 and limit < 1", async () => {
    const caller = appRouter.createCaller({});
    let oversize = false;
    try {
      await caller.tasks.list({ limit: 101 });
    } catch {
      oversize = true;
    }
    expect(oversize).toBe(true);

    let undersize = false;
    try {
      await caller.tasks.list({ limit: 0 });
    } catch {
      undersize = true;
    }
    expect(undersize).toBe(true);
  });

  it("projects exactly the nine documented DTO fields", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    seedTasks(sqlite, [
      {
        sessionId: "alpha-s",
        prompt: "P",
        status: "done",
        costUsd: 0.01,
        durationMs: 1234,
        channel: "telegram",
        createdAt: "2026-05-05 09:00:00",
        completedAt: "2026-05-05 09:00:05",
      },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items } = await caller.tasks.list({});
    expect(items.length).toBe(1);
    const keys = Object.keys(items[0]!).sort();
    expect(keys).toEqual([
      "agentName",
      "channel",
      "completedAt",
      "costUsd",
      "createdAt",
      "durationMs",
      "id",
      "prompt",
      "status",
    ]);
  });

  it("LEFT JOIN keeps tasks whose session_id has no matching agent", async () => {
    // Orphaned tasks should still surface (agentName === null) — the
    // global table is descriptive, not gating.
    const sqlite = new Database(dbPath);
    seedTasks(sqlite, [
      { sessionId: "ghost-session", prompt: "orphan" },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const { items } = await caller.tasks.list({});
    expect(items.length).toBe(1);
    expect(items[0]!.prompt).toBe("orphan");
    expect(items[0]!.agentName).toBeNull();
  });
});

describe("tasks.get", () => {
  it("returns null for an unknown id (no throw)", async () => {
    const caller = appRouter.createCaller({});
    const result = await caller.tasks.get({ id: 999_999 });
    expect(result).toBeNull();
  });

  it("returns the curated DTO for a known id", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    const id = seedTaskDetail(sqlite, {
      sessionId: "alpha-s",
      prompt: "do the thing",
      status: "done",
      costUsd: 0.0123,
      durationMs: 5432,
      numTurns: 4,
      exitCode: 0,
      errorMessage: null,
      model: "sonnet",
      taskType: "standard",
      parentTaskId: null,
      channel: "telegram",
      channelChatId: "12345",
      channelMessageId: "678",
      createdAt: "2026-05-05 09:00:00",
      startedAt: "2026-05-05 09:00:01",
      completedAt: "2026-05-05 09:00:06",
      resultSummary: "All done.",
      // Internal columns the wire DTO must drop:
      pid: 4242,
      resultFile: "/var/log/result.md",
      userId: "u-1",
    });
    sqlite.close();

    const caller = appRouter.createCaller({});
    const detail = await caller.tasks.get({ id });
    expect(detail).not.toBeNull();
    if (!detail) return;

    const keys = Object.keys(detail).sort();
    expect(keys).toEqual([
      "agentName",
      "channel",
      "channelChatId",
      "channelMessageId",
      "completedAt",
      "costUsd",
      "createdAt",
      "durationMs",
      "errorMessage",
      "exitCode",
      "id",
      "model",
      "numTurns",
      "parentTaskId",
      "prompt",
      "resultMarkdown",
      "resultMarkdownTruncated",
      "sessionId",
      "startedAt",
      "status",
      "taskType",
    ]);

    expect(detail.id).toBe(id);
    expect(detail.agentName).toBe("alpha");
    expect(detail.prompt).toBe("do the thing");
    expect(detail.status).toBe("done");
    expect(detail.costUsd).toBe(0.0123);
    expect(detail.durationMs).toBe(5432);
    expect(detail.numTurns).toBe(4);
    expect(detail.exitCode).toBe(0);
    expect(detail.errorMessage).toBeNull();
    expect(detail.model).toBe("sonnet");
    expect(detail.taskType).toBe("standard");
    expect(detail.parentTaskId).toBeNull();
    expect(detail.channel).toBe("telegram");
    expect(detail.channelChatId).toBe("12345");
    expect(detail.channelMessageId).toBe("678");
    expect(detail.sessionId).toBe("alpha-s");
    expect(detail.startedAt).toBe("2026-05-05 09:00:01");
    expect(detail.completedAt).toBe("2026-05-05 09:00:06");
    expect(detail.resultMarkdown).toBe("All done.");
    expect(detail.resultMarkdownTruncated).toBe(false);

    // Internal columns must NOT leak onto the wire.
    expect(keys.includes("pid")).toBe(false);
    expect(keys.includes("resultFile")).toBe(false);
    expect(keys.includes("userId")).toBe(false);
    expect(keys.includes("reported")).toBe(false);
    expect(keys.includes("position")).toBe(false);
  });

  it("resolves agentName for a task whose session has an agent row", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    const id = seedTaskDetail(sqlite, {
      sessionId: "alpha-s",
      prompt: "p",
    });
    sqlite.close();

    const caller = appRouter.createCaller({});
    const detail = await caller.tasks.get({ id });
    expect(detail?.agentName).toBe("alpha");
  });

  it("returns agentName=null for an orphaned task (no joined agent row)", async () => {
    const sqlite = new Database(dbPath);
    const id = seedTaskDetail(sqlite, {
      sessionId: "ghost-session",
      prompt: "orphan",
    });
    sqlite.close();

    const caller = appRouter.createCaller({});
    const detail = await caller.tasks.get({ id });
    expect(detail).not.toBeNull();
    expect(detail!.agentName).toBeNull();
  });

  it("resultMarkdown mirrors result_summary when under the byte cap", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    const id = seedTaskDetail(sqlite, {
      sessionId: "alpha-s",
      prompt: "p",
      resultSummary: "# Hello\n\nWorld.",
    });
    sqlite.close();

    const caller = appRouter.createCaller({});
    const detail = await caller.tasks.get({ id });
    expect(detail!.resultMarkdown).toBe("# Hello\n\nWorld.");
    expect(detail!.resultMarkdownTruncated).toBe(false);
  });

  it("resultMarkdown is null when result_summary is null", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    const id = seedTaskDetail(sqlite, {
      sessionId: "alpha-s",
      prompt: "p",
      resultSummary: null,
    });
    sqlite.close();

    const caller = appRouter.createCaller({});
    const detail = await caller.tasks.get({ id });
    expect(detail!.resultMarkdown).toBeNull();
    expect(detail!.resultMarkdownTruncated).toBe(false);
  });

  it("clips resultMarkdown at 500_000 bytes and flags truncated=true", async () => {
    const huge = "a".repeat(600_000);
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    const id = seedTaskDetail(sqlite, {
      sessionId: "alpha-s",
      prompt: "p",
      resultSummary: huge,
    });
    sqlite.close();

    const caller = appRouter.createCaller({});
    const detail = await caller.tasks.get({ id });
    expect(detail!.resultMarkdownTruncated).toBe(true);
    expect(detail!.resultMarkdown).not.toBeNull();
    const byteLen = Buffer.byteLength(detail!.resultMarkdown!, "utf8");
    expect(byteLen).toBeLessThanOrEqual(500_000);
  });

  it("does not flag truncated when payload is exactly under the cap", async () => {
    const justUnder = "a".repeat(500_000);
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha", sessionId: "alpha-s" },
    ]);
    const id = seedTaskDetail(sqlite, {
      sessionId: "alpha-s",
      prompt: "p",
      resultSummary: justUnder,
    });
    sqlite.close();

    const caller = appRouter.createCaller({});
    const detail = await caller.tasks.get({ id });
    expect(detail!.resultMarkdownTruncated).toBe(false);
    expect(detail!.resultMarkdown!.length).toBe(500_000);
  });

  it("Zod input rejects 0, negative, fractional, and missing ids", async () => {
    const caller = appRouter.createCaller({});

    let zero = false;
    try {
      await caller.tasks.get({ id: 0 });
    } catch {
      zero = true;
    }
    expect(zero).toBe(true);

    let negative = false;
    try {
      await caller.tasks.get({ id: -1 });
    } catch {
      negative = true;
    }
    expect(negative).toBe(true);

    let fractional = false;
    try {
      await caller.tasks.get({ id: 1.5 });
    } catch {
      fractional = true;
    }
    expect(fractional).toBe(true);

    let missing = false;
    try {
      // @ts-expect-error -- testing runtime validation
      await caller.tasks.get({});
    } catch {
      missing = true;
    }
    expect(missing).toBe(true);
  });
});

describe("tasks.transcript", () => {
  it("returns null for an unknown task id (no throw)", async () => {
    const caller = appRouter.createCaller({});
    const result = await caller.tasks.transcript({ id: 999_999 });
    expect(result).toBeNull();
  });

  it("returns fileMissing=true when the JSONL is absent", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha-proj", sessionId: "session-A" },
    ]);
    const id = seedTaskDetail(sqlite, {
      sessionId: "session-A",
      prompt: "p",
    });
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.tasks.transcript({ id });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.fileMissing).toBe(true);
    expect(result.turns).toEqual([]);
    expect(result.totalLines).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.fileTooLarge).toBe(false);
    expect(result.fileBytes).toBe(0);
    // The path string is computed from project_dir + session_id.
    expect(result.filePath).toContain("-tmp-alpha-proj");
    expect(result.filePath).toContain("session-A.jsonl");
  });

  it("reads + parses a 3-line fixture in order", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha-proj", sessionId: "session-B" },
    ]);
    const id = seedTaskDetail(sqlite, {
      sessionId: "session-B",
      prompt: "p",
    });
    sqlite.close();

    writeTranscriptFixture(tmpDir, "/tmp/alpha-proj", "session-B", [
      JSON.stringify({ type: "system", uuid: "s-1", content: "boot" }),
      JSON.stringify({
        type: "user",
        uuid: "u-1",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a-1",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "yo" }],
        },
      }),
    ]);

    const caller = appRouter.createCaller({});
    const result = await caller.tasks.transcript({ id });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.fileMissing).toBe(false);
    expect(result.fileTooLarge).toBe(false);
    expect(result.totalLines).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.turns.length).toBe(3);
    expect(result.turns[0]!.kind).toBe("system");
    expect(result.turns[1]!.kind).toBe("user");
    expect(result.turns[2]!.kind).toBe("assistant_text");
  });

  it("flags fileTooLarge when the JSONL exceeds 5 MB", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha-proj", sessionId: "session-C" },
    ]);
    const id = seedTaskDetail(sqlite, {
      sessionId: "session-C",
      prompt: "p",
    });
    sqlite.close();

    // Generate ~6MB of garbage.
    const big = "x".repeat(6 * 1024 * 1024);
    writeTranscriptFixture(tmpDir, "/tmp/alpha-proj", "session-C", [big]);

    const caller = appRouter.createCaller({});
    const result = await caller.tasks.transcript({ id });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.fileTooLarge).toBe(true);
    expect(result.turns).toEqual([]);
    expect(result.fileBytes).toBeGreaterThan(5_000_000);
  });

  it("keeps the most-recent 500 turns when the fixture has 600 lines", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha-proj", sessionId: "session-D" },
    ]);
    const id = seedTaskDetail(sqlite, {
      sessionId: "session-D",
      prompt: "p",
    });
    sqlite.close();

    const fixtureLines = Array.from({ length: 600 }, (_, i) =>
      JSON.stringify({
        type: "user",
        uuid: `u-${i}`,
        message: { role: "user", content: `msg ${i}` },
      }),
    );
    writeTranscriptFixture(tmpDir, "/tmp/alpha-proj", "session-D", fixtureLines);

    const caller = appRouter.createCaller({});
    const result = await caller.tasks.transcript({ id });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.totalLines).toBe(600);
    expect(result.truncated).toBe(true);
    expect(result.turns.length).toBe(500);
    if (result.turns[0]!.kind === "user") {
      expect(result.turns[0]!.text).toBe("msg 100");
    }
    if (result.turns[499]!.kind === "user") {
      expect(result.turns[499]!.text).toBe("msg 599");
    }
  });

  it("surfaces toolName / toolUseId / inputJson on a tool_use turn", async () => {
    const sqlite = new Database(dbPath);
    seedAgents(sqlite, [
      { name: "alpha", projectDir: "/tmp/alpha-proj", sessionId: "session-E" },
    ]);
    const id = seedTaskDetail(sqlite, {
      sessionId: "session-E",
      prompt: "p",
    });
    sqlite.close();

    writeTranscriptFixture(tmpDir, "/tmp/alpha-proj", "session-E", [
      JSON.stringify({
        type: "assistant",
        uuid: "a-1",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          content: [
            {
              type: "tool_use",
              id: "toolu_99",
              name: "Read",
              input: { file_path: "/tmp/foo" },
            },
          ],
        },
      }),
    ]);

    const caller = appRouter.createCaller({});
    const result = await caller.tasks.transcript({ id });
    expect(result).not.toBeNull();
    if (!result) return;
    const t = result.turns[0]!;
    expect(t.kind).toBe("assistant_tool_use");
    if (t.kind === "assistant_tool_use") {
      expect(t.toolName).toBe("Read");
      expect(t.toolUseId).toBe("toolu_99");
      expect(JSON.parse(t.inputJson)).toEqual({ file_path: "/tmp/foo" });
    }
  });

  it("Zod input rejects 0 / negative / fractional / missing ids", async () => {
    const caller = appRouter.createCaller({});

    let zero = false;
    try {
      await caller.tasks.transcript({ id: 0 });
    } catch {
      zero = true;
    }
    expect(zero).toBe(true);

    let negative = false;
    try {
      await caller.tasks.transcript({ id: -1 });
    } catch {
      negative = true;
    }
    expect(negative).toBe(true);

    let fractional = false;
    try {
      await caller.tasks.transcript({ id: 1.5 });
    } catch {
      fractional = true;
    }
    expect(fractional).toBe(true);

    let missing = false;
    try {
      // @ts-expect-error -- testing runtime validation
      await caller.tasks.transcript({});
    } catch {
      missing = true;
    }
    expect(missing).toBe(true);
  });
});
