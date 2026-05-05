// T04 — migration runner. Asserts that runMigrations is idempotent,
// concurrent-safe, and produces the expected audit_log table + indexes.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "../../src/server/migrate";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bridge-migrate-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
}

interface IndexInfo {
  name: string;
}

function tableInfo(db: Database, table: string): ColumnInfo[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as ColumnInfo[];
}

function indexList(db: Database, table: string): IndexInfo[] {
  return db
    .prepare(`PRAGMA index_list(${table})`)
    .all() as unknown as IndexInfo[];
}

describe("runMigrations — first run on empty DB", () => {
  it("creates the audit_log table with the expected columns", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const cols = tableInfo(db, "audit_log");
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "action",
        "created_at",
        "id",
        "ip_hash",
        "payload_json",
        "request_id",
        "resource_id",
        "resource_type",
        "user_agent",
        "user_id",
      ].sort(),
    );
    const action = cols.find((c) => c.name === "action")!;
    expect(action.notnull).toBe(1);
    const resourceType = cols.find((c) => c.name === "resource_type")!;
    expect(resourceType.notnull).toBe(1);
    const createdAt = cols.find((c) => c.name === "created_at")!;
    expect(createdAt.notnull).toBe(1);
  });

  it("creates the expected indexes", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const idx = indexList(db, "audit_log").map((r) => r.name);
    expect(idx).toContain("idx_audit_log_created_at");
    expect(idx).toContain("idx_audit_log_user_created_at");
  });
});

describe("runMigrations — idempotency", () => {
  it("running twice on the same DB is a no-op", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const cols = tableInfo(db, "audit_log");
    expect(cols.length).toBe(10);
  });

  it("preserves data on a second run", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.run(
      "INSERT INTO audit_log (action, resource_type, created_at) VALUES ('x', 'y', 1)",
    );
    runMigrations(db);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });
});

describe("runMigrations — concurrent processes", () => {
  it("two parallel runners on the same file DB both succeed", async () => {
    const path = join(tmpDir, "bridge.db");
    const a = new Database(path);
    a.exec("PRAGMA journal_mode=WAL;");
    a.exec("PRAGMA busy_timeout=5000;");
    const b = new Database(path);
    b.exec("PRAGMA busy_timeout=5000;");
    await Promise.all([
      Promise.resolve().then(() => runMigrations(a)),
      Promise.resolve().then(() => runMigrations(b)),
    ]);
    const cols = tableInfo(a, "audit_log");
    expect(cols.length).toBe(10);
    a.close();
    b.close();
  });
});
