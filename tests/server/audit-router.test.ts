// P2-T05 — `audit.list` router. Read-side query over the dashboard-owned
// `audit_log` table that T04 wrote. Tests cover order, filters, paging,
// payload parsing, and the `<anonymous>` user_id sentinel for null rows.
//
// Test seam: seed rows by raw SQL so we control `created_at` exactly
// (appendAudit timestamps each row at `Date.now()`, which makes the
// since/until / cursor tests fragile). The router only reads, so this
// keeps the assertion shape independent of T04's helper.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appRouter } from "../../src/server/routers/_app";
import { resetDb } from "../../src/server/db";
import { runMigrations } from "../../src/server/migrate";

let tmpDir: string;
let dbPath: string;
const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;

interface AuditSeed {
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  payloadJson?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  createdAt: number;
}

function seed(db: Database, rows: AuditSeed[]): void {
  const stmt = db.prepare(`
    INSERT INTO audit_log
      (user_id, action, resource_type, resource_id,
       payload_json, ip_hash, user_agent, request_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(
      r.userId ?? null,
      r.action,
      r.resourceType,
      r.resourceId ?? null,
      r.payloadJson ?? null,
      r.ipHash ?? null,
      r.userAgent ?? null,
      r.requestId ?? null,
      r.createdAt,
    );
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "audit-router-test-"));
  dbPath = join(tmpDir, "bridge.db");
  process.env.BRIDGE_DB = dbPath;
  // Touching getDb() runs migrations and creates audit_log. We seed
  // through the same handle so the router's createCaller() reads
  // exactly what the test wrote.
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

function openSeededDb(): Database {
  // Open a parallel handle and run migrations on it directly. The
  // dashboard's getDb() will lazily open its own handle on the same
  // path when the router is invoked; both see the same on-disk file
  // and the migration is idempotent (T04 acceptance criterion 2).
  const db = new Database(dbPath);
  runMigrations(db);
  return db;
}

describe("audit.list — empty + ordering", () => {
  it("returns empty page on a fresh DB", async () => {
    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({});
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeNull();
  });

  it("orders rows DESC by created_at, then id", async () => {
    const db = openSeededDb();
    seed(db, [
      { action: "task.dispatch", resourceType: "task", createdAt: 100 },
      { action: "task.kill", resourceType: "task", createdAt: 200 },
      { action: "loop.approve", resourceType: "loop", createdAt: 150 },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({});
    expect(r.items.map((x) => x.action)).toEqual([
      "task.kill",
      "loop.approve",
      "task.dispatch",
    ]);
  });
});

describe("audit.list — pagination", () => {
  it("uses default limit 100 and emits a cursor when more rows exist", async () => {
    const db = openSeededDb();
    const rows: AuditSeed[] = [];
    for (let i = 1; i <= 250; i++) {
      rows.push({
        action: "task.dispatch",
        resourceType: "task",
        createdAt: i,
      });
    }
    seed(db, rows);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const page1 = await caller.audit.list({});
    expect(page1.items.length).toBe(100);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.items[0]!.createdAt).toBe(250); // newest first

    const page2 = await caller.audit.list({ cursor: page1.nextCursor! });
    expect(page2.items.length).toBe(100);
    expect(page2.nextCursor).not.toBeNull();
    expect(page2.items[0]!.createdAt).toBeLessThan(page1.items[99]!.createdAt);

    const page3 = await caller.audit.list({ cursor: page2.nextCursor! });
    expect(page3.items.length).toBe(50);
    expect(page3.nextCursor).toBeNull();
  });

  it("respects custom limit", async () => {
    const db = openSeededDb();
    seed(db, [
      { action: "a", resourceType: "x", createdAt: 1 },
      { action: "b", resourceType: "x", createdAt: 2 },
      { action: "c", resourceType: "x", createdAt: 3 },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({ limit: 2 });
    expect(r.items.length).toBe(2);
    expect(r.nextCursor).not.toBeNull();
  });

  it("rejects limit > 200 as BAD_REQUEST", async () => {
    const caller = appRouter.createCaller({ userId: "owner" });
    let threw = false;
    try {
      await caller.audit.list({ limit: 500 });
    } catch (err) {
      threw = true;
      expect((err as { code?: string }).code).toBe("BAD_REQUEST");
    }
    expect(threw).toBe(true);
  });

  it("paginates stably across same-millisecond timestamps", async () => {
    const db = openSeededDb();
    seed(db, [
      { action: "a", resourceType: "x", createdAt: 1000 },
      { action: "b", resourceType: "x", createdAt: 1000 },
      { action: "c", resourceType: "x", createdAt: 1000 },
      { action: "d", resourceType: "x", createdAt: 1000 },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const page1 = await caller.audit.list({ limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();
    const seen = new Set<number>();
    page1.items.forEach((x) => seen.add(x.id));

    const page2 = await caller.audit.list({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.length).toBe(2);
    page2.items.forEach((x) => {
      expect(seen.has(x.id)).toBe(false);
      seen.add(x.id);
    });

    // Cursor-pagination cannot know it's at the end without a probe;
    // a third page returns 0 rows and finally a null cursor.
    const page3 = await caller.audit.list({ limit: 2, cursor: page2.nextCursor! });
    expect(page3.items.length).toBe(0);
    expect(page3.nextCursor).toBeNull();
  });
});

describe("audit.list — filters", () => {
  it("filters by action exact-match", async () => {
    const db = openSeededDb();
    seed(db, [
      { action: "task.dispatch", resourceType: "task", createdAt: 1 },
      { action: "task.kill", resourceType: "task", createdAt: 2 },
      { action: "task.dispatch", resourceType: "task", createdAt: 3 },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({ action: "task.dispatch" });
    expect(r.items.length).toBe(2);
    expect(r.items.every((x) => x.action === "task.dispatch")).toBe(true);
  });

  it("filters by resourceType", async () => {
    const db = openSeededDb();
    seed(db, [
      { action: "task.dispatch", resourceType: "task", createdAt: 1 },
      { action: "loop.approve", resourceType: "loop", createdAt: 2 },
      { action: "csrf_invalid", resourceType: "auth", createdAt: 3 },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({ resourceType: "loop" });
    expect(r.items.length).toBe(1);
    expect(r.items[0]!.action).toBe("loop.approve");
  });

  it("filters by userId exact-match", async () => {
    const db = openSeededDb();
    seed(db, [
      {
        userId: "owner",
        action: "task.dispatch",
        resourceType: "task",
        createdAt: 1,
      },
      {
        userId: "alice",
        action: "task.dispatch",
        resourceType: "task",
        createdAt: 2,
      },
      {
        userId: null,
        action: "csrf_invalid",
        resourceType: "auth",
        createdAt: 3,
      },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({ userId: "owner" });
    expect(r.items.length).toBe(1);
    expect(r.items[0]!.userId).toBe("owner");
  });

  it("`<anonymous>` userId sentinel matches NULL user_id rows", async () => {
    const db = openSeededDb();
    seed(db, [
      {
        userId: "owner",
        action: "task.dispatch",
        resourceType: "task",
        createdAt: 1,
      },
      {
        userId: null,
        action: "csrf_invalid",
        resourceType: "auth",
        createdAt: 2,
      },
      {
        userId: null,
        action: "rate_limit_blocked",
        resourceType: "auth",
        createdAt: 3,
      },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({ userId: "<anonymous>" });
    expect(r.items.length).toBe(2);
    expect(r.items.every((x) => x.userId === null)).toBe(true);
  });

  it("filters by since/until inclusive bounds", async () => {
    const db = openSeededDb();
    seed(db, [
      { action: "a", resourceType: "x", createdAt: 1 },
      { action: "b", resourceType: "x", createdAt: 2 },
      { action: "c", resourceType: "x", createdAt: 3 },
      { action: "d", resourceType: "x", createdAt: 4 },
      { action: "e", resourceType: "x", createdAt: 5 },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({ since: 3, until: 4 });
    expect(r.items.map((x) => x.action).sort()).toEqual(["c", "d"]);
  });

  it("combines action + since + until as AND", async () => {
    const db = openSeededDb();
    seed(db, [
      { action: "csrf_invalid", resourceType: "auth", createdAt: 10 },
      { action: "csrf_invalid", resourceType: "auth", createdAt: 20 },
      { action: "csrf_invalid", resourceType: "auth", createdAt: 30 },
      { action: "task.dispatch", resourceType: "task", createdAt: 20 },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({
      action: "csrf_invalid",
      since: 15,
      until: 25,
    });
    expect(r.items.length).toBe(1);
    expect(r.items[0]!.createdAt).toBe(20);
    expect(r.items[0]!.action).toBe("csrf_invalid");
  });
});

describe("audit.list — payload parsing", () => {
  it("parses valid JSON payload into `payload`", async () => {
    const db = openSeededDb();
    seed(db, [
      {
        action: "task.dispatch",
        resourceType: "task",
        payloadJson: JSON.stringify({ agentName: "x", model: "opus" }),
        createdAt: 1,
      },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({});
    expect(r.items.length).toBe(1);
    expect(r.items[0]!.payload).toEqual({ agentName: "x", model: "opus" });
    expect(r.items[0]!.payloadJson).toBe(
      JSON.stringify({ agentName: "x", model: "opus" }),
    );
  });

  it("returns null payload on invalid JSON, but preserves raw string", async () => {
    const db = openSeededDb();
    seed(db, [
      {
        action: "task.dispatch",
        resourceType: "task",
        payloadJson: "{not json",
        createdAt: 1,
      },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({});
    expect(r.items[0]!.payload).toBeNull();
    expect(r.items[0]!.payloadJson).toBe("{not json");
  });

  it("surfaces null payloadJson as null on both fields", async () => {
    const db = openSeededDb();
    seed(db, [
      {
        action: "task.kill",
        resourceType: "task",
        payloadJson: null,
        createdAt: 1,
      },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({});
    expect(r.items[0]!.payload).toBeNull();
    expect(r.items[0]!.payloadJson).toBeNull();
  });
});

describe("audit.list — DTO shape", () => {
  it("surfaces every audit_log column on the wire", async () => {
    const db = openSeededDb();
    seed(db, [
      {
        userId: "owner",
        action: "task.dispatch",
        resourceType: "task",
        resourceId: "42",
        payloadJson: JSON.stringify({ agentName: "x" }),
        ipHash: "deadbeef",
        userAgent: "Mozilla/5.0",
        requestId: "11111111-2222-3333-4444-555555555555",
        createdAt: 1700000000000,
      },
    ]);
    db.close();

    const caller = appRouter.createCaller({ userId: "owner" });
    const r = await caller.audit.list({});
    const row = r.items[0]!;
    expect(row.id).toBeGreaterThan(0);
    expect(row.userId).toBe("owner");
    expect(row.action).toBe("task.dispatch");
    expect(row.resourceType).toBe("task");
    expect(row.resourceId).toBe("42");
    expect(row.payloadJson).toBe(JSON.stringify({ agentName: "x" }));
    expect(row.payload).toEqual({ agentName: "x" });
    expect(row.ipHash).toBe("deadbeef");
    expect(row.userAgent).toBe("Mozilla/5.0");
    expect(row.requestId).toBe("11111111-2222-3333-4444-555555555555");
    expect(row.createdAt).toBe(1700000000000);
  });
});
