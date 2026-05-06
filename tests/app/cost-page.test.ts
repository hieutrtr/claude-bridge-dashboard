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

let tmpDir: string;
let dbPath: string;
const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;

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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cost-page-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(SCHEMA_DDL);
  sqlite.close();
  process.env.BRIDGE_DB = dbPath;
  resetDb();
  __setSessionSubjectForTest("owner");
});

afterEach(() => {
  __clearSessionSubjectForTest();
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_BRIDGE_DB === undefined) {
    delete process.env.BRIDGE_DB;
  } else {
    process.env.BRIDGE_DB = ORIGINAL_BRIDGE_DB;
  }
  resetDb();
});

describe("/cost page", () => {
  it("module exports a default async function", async () => {
    const mod = await import("../../app/cost/page");
    expect(typeof mod.default).toBe("function");
  });

  it("does NOT export POST/PUT/PATCH/DELETE handlers (read-only invariant)", async () => {
    const mod = await import("../../app/cost/page");
    expect((mod as Record<string, unknown>).POST).toBeUndefined();
    expect((mod as Record<string, unknown>).PUT).toBeUndefined();
    expect((mod as Record<string, unknown>).PATCH).toBeUndefined();
    expect((mod as Record<string, unknown>).DELETE).toBeUndefined();
  });

  it("renders the empty-state copy when no done tasks exist", async () => {
    const mod = await import("../../app/cost/page");
    const tree = await mod.default();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Cost");
    expect(html).toContain("Total spend");
    expect(html).toContain("Tasks");
    expect(html).toContain("Avg / task");
    expect(html).toContain("No completed tasks yet");
  });

  it("renders KPI numbers from the analytics summary when seeded", async () => {
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      INSERT INTO agents (name, project_dir, session_id, agent_file)
      VALUES ('alpha', '/tmp/alpha', 's-alpha', '/tmp/alpha.md');
      INSERT INTO tasks (session_id, prompt, status, cost_usd, model, completed_at)
      VALUES
        ('s-alpha', 't', 'done', 1.50, 'opus', datetime('now', '-1 hours')),
        ('s-alpha', 't', 'done', 0.50, 'opus', datetime('now', '-2 hours'));
    `);
    sqlite.close();

    const mod = await import("../../app/cost/page");
    const tree = await mod.default();
    const html = renderToStaticMarkup(tree);
    // The empty-state branch should NOT render once we have completed tasks.
    expect(html).not.toContain("No completed tasks yet");
    expect(html).toContain("Total spend");
    // $2.00 = 1.50 + 0.50
    expect(html).toContain("$2.00");
    // Tasks = 2
    expect(html).toContain(">2<");
    // Avg = $1.00
    expect(html).toContain("$1.00");
  });
});
