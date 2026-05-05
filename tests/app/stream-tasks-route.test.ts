import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetDb } from "../../src/server/db";

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
  tmpDir = mkdtempSync(join(tmpdir(), "stream-tasks-route-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(SCHEMA_DDL);
  sqlite.prepare(
    `INSERT INTO tasks (session_id, prompt, status, cost_usd, completed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("alpha-s", "first", "running", null, null);
  sqlite.prepare(
    `INSERT INTO tasks (session_id, prompt, status, cost_usd, completed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("alpha-s", "second", "done", 0.42, "2026-05-05 10:00:00");
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

describe("/api/stream/tasks route", () => {
  it("module exports a GET handler and no mutation handlers", async () => {
    const mod = await import("../../app/api/stream/tasks/route");
    expect(typeof mod.GET).toBe("function");
    expect((mod as Record<string, unknown>).POST).toBeUndefined();
    expect((mod as Record<string, unknown>).PUT).toBeUndefined();
    expect((mod as Record<string, unknown>).PATCH).toBeUndefined();
    expect((mod as Record<string, unknown>).DELETE).toBeUndefined();
  });

  it("returns a Response with text/event-stream and emits init for seeded tasks", async () => {
    const mod = await import("../../app/api/stream/tasks/route");
    const ac = new AbortController();
    const req = new Request("http://localhost/api/stream/tasks", {
      method: "GET",
      signal: ac.signal,
    });
    const res = await mod.GET(req);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 500),
        ),
      ]);
      if (result.done) break;
      buf += decoder.decode(result.value);
      if (buf.includes("event: init")) break;
    }
    expect(buf).toContain("event: init");
    expect(buf).toContain('"id":1');
    expect(buf).toContain('"id":2');
    expect(buf).toContain('"status":"running"');
    expect(buf).toContain('"status":"done"');

    ac.abort();
    reader.cancel().catch(() => {});
  });
});
