// P2-T09 — route smoke for /api/stream/permissions. Mirrors
// `tests/app/stream-tasks-route.test.ts` — boots a tmp DB with a
// `permissions` table, seeds one pending row, drives the GET
// handler, asserts the SSE init event contains the seeded row.

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
  CREATE TABLE permissions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    command TEXT,
    description TEXT,
    status TEXT DEFAULT 'pending',
    response TEXT,
    created_at NUMERIC DEFAULT CURRENT_TIMESTAMP,
    responded_at NUMERIC,
    timeout_seconds INTEGER DEFAULT 300
  );
`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "stream-permissions-route-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(SCHEMA_DDL);
  sqlite.prepare(
    `INSERT INTO permissions (id, session_id, tool_name, command, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("perm-x", "sess-1", "Bash", "ls /tmp", "pending");
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

describe("/api/stream/permissions route", () => {
  it("module exports a GET handler and no mutation handlers", async () => {
    const mod = await import("../../app/api/stream/permissions/route");
    expect(typeof mod.GET).toBe("function");
    expect((mod as Record<string, unknown>).POST).toBeUndefined();
    expect((mod as Record<string, unknown>).PUT).toBeUndefined();
    expect((mod as Record<string, unknown>).PATCH).toBeUndefined();
    expect((mod as Record<string, unknown>).DELETE).toBeUndefined();
  });

  it("returns a Response with text/event-stream and emits init for seeded pending row", async () => {
    const mod = await import("../../app/api/stream/permissions/route");
    const ac = new AbortController();
    const req = new Request("http://localhost/api/stream/permissions", {
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
    expect(buf).toContain('"id":"perm-x"');
    expect(buf).toContain('"toolName":"Bash"');

    ac.abort();
    reader.cancel().catch(() => {});
  });
});
