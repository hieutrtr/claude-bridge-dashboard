// P2-T09 — integration tests for the `permissions.respond` tRPC
// mutation. Tmp on-disk DB with the daemon-owned `permissions` table
// + the dashboard's `audit_log` table (created by `runMigrations` in
// `getSqlite()`).
//
// The procedure does not call MCP — v1 ARCH §10 inherits the existing
// `permissions` table contract: the daemon polls; the dashboard
// updates `status`/`response`/`responded_at` directly. Idempotency
// surface mirrors `tasks.kill` and `loops.approve/reject`:
// already-resolved → `{ ok:true, alreadyResolved:true }`, no UPDATE
// issued, audit row recorded.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";

import { appRouter } from "../../src/server/routers/_app";
import { resetDb, getSqlite } from "../../src/server/db";
import { __resetAudit, __setAuditDb } from "../../src/server/audit";

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

interface AuditRow {
  id: number;
  user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  payload_json: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  request_id: string | null;
  created_at: number;
}

function rows(db: Database): AuditRow[] {
  return db
    .prepare("SELECT * FROM audit_log ORDER BY id ASC")
    .all() as unknown as AuditRow[];
}

interface PermRow {
  id: string;
  session_id: string;
  tool_name: string;
  command: string | null;
  description: string | null;
  status: string | null;
  response: string | null;
  responded_at: string | null;
}

function permRow(db: Database, id: string): PermRow | undefined {
  return db
    .prepare("SELECT * FROM permissions WHERE id = ?")
    .get(id) as PermRow | undefined;
}

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/trpc/permissions.respond", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

interface SeedOpts {
  id: string;
  sessionId?: string;
  toolName?: string;
  command?: string | null;
  description?: string | null;
  status?: string;
  response?: string | null;
}

function seed(db: Database, o: SeedOpts): void {
  db.prepare(
    `INSERT INTO permissions
       (id, session_id, tool_name, command, description, status, response)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id,
    o.sessionId ?? "sess-1",
    o.toolName ?? "Bash",
    o.command ?? "ls",
    o.description ?? null,
    o.status ?? "pending",
    o.response ?? null,
  );
}

const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  process.env.JWT_SECRET = "perm-test-secret-please-do-not-use-in-prod";
  process.env.AUDIT_IP_HASH_SALT = "salty-perms";
  tmpDir = mkdtempSync(join(tmpdir(), "permissions-router-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const setup = new Database(dbPath);
  setup.exec(SCHEMA_DDL);
  setup.close();
  process.env.BRIDGE_DB = dbPath;
  resetDb();
  db = getSqlite();
  __resetAudit();
  __setAuditDb(db);
});

afterEach(() => {
  __setAuditDb(null);
  __resetAudit();
  resetDb();
  rmSync(tmpDir, { recursive: true, force: true });
  for (const key of [
    "JWT_SECRET",
    "AUDIT_IP_HASH_SALT",
    "BRIDGE_DB",
  ] as const) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key]!;
  }
});

// ─────────────────────────────────────────────────────────────────────
// Happy paths
// ─────────────────────────────────────────────────────────────────────

describe("permissions.respond — happy path approved", () => {
  it("flips a pending row to approved and writes one audit row", async () => {
    seed(db, { id: "perm-1", toolName: "Bash", command: "rm -rf /tmp/x" });
    const req = makeReq({ "x-forwarded-for": "5.6.7.8", "user-agent": "ua/1" });
    const caller = appRouter.createCaller({ userId: "owner", req });

    const out = await caller.permissions.respond({
      id: "perm-1",
      decision: "approved",
    });
    expect(out).toEqual({ ok: true, alreadyResolved: false });

    const row = permRow(db, "perm-1");
    expect(row?.status).toBe("approved");
    expect(row?.response).toBe("approved");
    expect(row?.responded_at).not.toBeNull();
    expect(row?.command).toBe("rm -rf /tmp/x"); // unchanged

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("permission.respond");
    expect(all[0]!.resource_type).toBe("permission");
    expect(all[0]!.resource_id).toBe("perm-1");
    expect(all[0]!.user_id).toBe("owner");
    expect(all[0]!.ip_hash).not.toBeNull();
    expect(all[0]!.user_agent).toBe("ua/1");
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload.decision).toBe("approved");
    expect(payload.toolName).toBe("Bash");
    expect(payload.sessionId).toBe("sess-1");
    expect(payload.alreadyResolved).toBe(false);
    // The shell command must NEVER end up in the audit row.
    expect(JSON.stringify(payload)).not.toContain("rm -rf");
    expect(payload.command).toBeUndefined();
  });
});

describe("permissions.respond — happy path denied", () => {
  it("flips a pending row to denied and writes one audit row", async () => {
    seed(db, { id: "perm-2", toolName: "Edit" });
    const caller = appRouter.createCaller({ userId: "owner", req: makeReq() });

    const out = await caller.permissions.respond({
      id: "perm-2",
      decision: "denied",
    });
    expect(out).toEqual({ ok: true, alreadyResolved: false });

    const row = permRow(db, "perm-2");
    expect(row?.status).toBe("denied");
    expect(row?.response).toBe("denied");
    expect(row?.responded_at).not.toBeNull();

    const payload = JSON.parse(rows(db)[0]!.payload_json!);
    expect(payload.decision).toBe("denied");
    expect(payload.toolName).toBe("Edit");
    expect(payload.alreadyResolved).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Race / idempotency
// ─────────────────────────────────────────────────────────────────────

describe("permissions.respond — already resolved (server-side check)", () => {
  for (const status of ["approved", "denied"] as const) {
    it(`status=${status} → alreadyResolved:true, no UPDATE`, async () => {
      seed(db, { id: `perm-${status}`, status, response: status });
      const caller = appRouter.createCaller({ userId: "owner", req: makeReq() });
      const out = await caller.permissions.respond({
        id: `perm-${status}`,
        decision: status === "approved" ? "denied" : "approved",
      });
      expect(out).toEqual({ ok: true, alreadyResolved: true });

      // Row unchanged — the dashboard does not over-write a finalized
      // decision (Telegram won the race).
      const row = permRow(db, `perm-${status}`);
      expect(row?.status).toBe(status);
      expect(row?.response).toBe(status);

      const payload = JSON.parse(rows(db)[0]!.payload_json!);
      expect(payload.alreadyResolved).toBe(true);
      expect(payload.toolName).toBe("Bash");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

describe("permissions.respond — unknown id", () => {
  it("throws NOT_FOUND, no audit row", async () => {
    const caller = appRouter.createCaller({ userId: "owner", req: makeReq() });
    let caught: TRPCError | null = null;
    try {
      await caller.permissions.respond({ id: "ghost", decision: "approved" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("NOT_FOUND");
    expect(rows(db).length).toBe(0);
  });
});

describe("permissions.respond — input validation", () => {
  it("rejects an empty id with BAD_REQUEST", async () => {
    const caller = appRouter.createCaller({ userId: "owner", req: makeReq() });
    let caught: TRPCError | null = null;
    try {
      await caller.permissions.respond({ id: "", decision: "approved" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(rows(db).length).toBe(0);
  });

  it("rejects an oversize id (>32 chars)", async () => {
    seed(db, { id: "perm-x" });
    const caller = appRouter.createCaller({ userId: "owner", req: makeReq() });
    let caught: TRPCError | null = null;
    try {
      await caller.permissions.respond({
        id: "x".repeat(33),
        decision: "approved",
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });

  it("rejects an unknown decision value", async () => {
    seed(db, { id: "perm-3" });
    const caller = appRouter.createCaller({ userId: "owner", req: makeReq() });
    let caught: TRPCError | null = null;
    try {
      // @ts-expect-error — runtime-only bad value
      await caller.permissions.respond({ id: "perm-3", decision: "maybe" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    // Row is untouched.
    const row = permRow(db, "perm-3");
    expect(row?.status).toBe("pending");
    expect(rows(db).length).toBe(0);
  });
});

describe("permissions.respond — privacy", () => {
  it("never echoes the command text into audit_log payload", async () => {
    seed(db, {
      id: "perm-secret",
      command: "psql -c 'SELECT pg_dump > /tmp/leak.sql'",
    });
    const caller = appRouter.createCaller({ userId: "owner", req: makeReq() });
    await caller.permissions.respond({
      id: "perm-secret",
      decision: "approved",
    });
    const payload = JSON.parse(rows(db)[0]!.payload_json!);
    expect(payload.command).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("pg_dump");
    expect(JSON.stringify(payload)).not.toContain("leak.sql");
  });
});
