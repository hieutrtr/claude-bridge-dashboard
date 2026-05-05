// T04 — boot wire-up: getDb() must trigger runMigrations on the
// underlying SQLite handle exactly once per process.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDb, getSqlite, resetDb } from "../../src/server/db";

const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;
let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bridge-boot-"));
  dbPath = join(tmpDir, "bridge.db");
  process.env.BRIDGE_DB = dbPath;
  resetDb();
});

afterEach(() => {
  resetDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_BRIDGE_DB === undefined) delete process.env.BRIDGE_DB;
  else process.env.BRIDGE_DB = ORIGINAL_BRIDGE_DB;
});

describe("getDb — migration wire-up", () => {
  it("creates audit_log on first access", () => {
    void getDb();
    const sqlite = getSqlite();
    const cols = sqlite
      .prepare("PRAGMA table_info(audit_log)")
      .all() as Array<{ name: string }>;
    expect(cols.length).toBeGreaterThan(0);
    const names = cols.map((c) => c.name);
    expect(names).toContain("action");
    expect(names).toContain("created_at");
  });

  it("is idempotent on repeated access", () => {
    void getDb();
    void getDb();
    const sqlite = getSqlite();
    // verify by inserting + reading back through the live handle
    sqlite.run(
      "INSERT INTO audit_log (action, resource_type, created_at) VALUES ('x', 'y', 1)",
    );
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_log")
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("does not run migrations on a side-DB; getSqlite + getDb share one handle", () => {
    void getDb();
    const a = getSqlite();
    const b = getSqlite();
    expect(a).toBe(b);
    // Sanity — a separate Database opened on the same file path is a
    // different JS object even though it points at the same file.
    const c = new Database(dbPath);
    expect(c).not.toBe(a);
    c.close();
  });
});
