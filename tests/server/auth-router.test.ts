// P4-T01 — auth.* tRPC router (auth.me + auth.logout). The magic-link
// HTTP routes (/api/auth/magic-link/*) are tested separately in
// `tests/app/auth-magic-link-*.test.ts`.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appRouter } from "../../src/server/routers/_app";
import { resetDb, getSqlite } from "../../src/server/db";
import { __resetAudit, __setAuditDb } from "../../src/server/audit";

const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  process.env.JWT_SECRET = "auth-router-test-secret";
  process.env.AUDIT_IP_HASH_SALT = "auth-router-salt";
  tmpDir = mkdtempSync(join(tmpdir(), "auth-router-test-"));
  dbPath = join(tmpDir, "bridge.db");
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
    "OWNER_EMAIL",
  ] as const) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key]!;
  }
});

function makeReq(): Request {
  return new Request("http://localhost/api/trpc/auth.me", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

function seedUser(opts: {
  id: string;
  email: string;
  role?: "owner" | "member";
  revokedAt?: number | null;
}): void {
  db.prepare(
    `INSERT INTO users (id, email, role, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.email,
    opts.role ?? "member",
    Date.now(),
    opts.revokedAt ?? null,
  );
}

describe("auth.me", () => {
  it("returns null when no userId on context (anonymous)", async () => {
    const caller = appRouter.createCaller({ req: makeReq(), userId: null });
    const out = await caller.auth.me();
    expect(out).toBeNull();
  });

  it("returns synthetic env-owner row for sub=owner (no users row needed)", async () => {
    process.env.OWNER_EMAIL = "hieu@example.com";
    const caller = appRouter.createCaller({ req: makeReq(), userId: "owner" });
    const out = await caller.auth.me();
    expect(out).not.toBeNull();
    expect(out!).toEqual({
      id: "owner",
      email: "hieu@example.com",
      role: "owner",
      displayName: null,
    });
  });

  it("falls back to owner@local when OWNER_EMAIL is not set", async () => {
    delete process.env.OWNER_EMAIL;
    const caller = appRouter.createCaller({ req: makeReq(), userId: "owner" });
    const out = await caller.auth.me();
    expect(out!.email).toBe("owner@local");
  });

  it("returns the users row for a magic-link sub (UUID)", async () => {
    seedUser({ id: "uuid-1", email: "alice@example.com", role: "member" });
    const caller = appRouter.createCaller({ req: makeReq(), userId: "uuid-1" });
    const out = await caller.auth.me();
    expect(out).toEqual({
      id: "uuid-1",
      email: "alice@example.com",
      role: "member",
      displayName: null,
    });
  });

  it("returns null for a sub that does not match any user", async () => {
    const caller = appRouter.createCaller({
      req: makeReq(),
      userId: "ghost-user",
    });
    const out = await caller.auth.me();
    expect(out).toBeNull();
  });

  it("returns null for a revoked user", async () => {
    seedUser({
      id: "uuid-revoked",
      email: "ex@example.com",
      revokedAt: Date.now(),
    });
    const caller = appRouter.createCaller({
      req: makeReq(),
      userId: "uuid-revoked",
    });
    const out = await caller.auth.me();
    expect(out).toBeNull();
  });

  it("returns owner role correctly when role=owner is on the row", async () => {
    seedUser({ id: "uuid-owner", email: "boss@example.com", role: "owner" });
    const caller = appRouter.createCaller({
      req: makeReq(),
      userId: "uuid-owner",
    });
    const out = await caller.auth.me();
    expect(out!.role).toBe("owner");
  });
});

describe("auth.logout", () => {
  it("audits with the session subject and returns ok:true", async () => {
    const caller = appRouter.createCaller({
      req: makeReq(),
      userId: "uuid-7",
    });
    const out = await caller.auth.logout();
    expect(out).toEqual({ ok: true });

    const rows = db
      .prepare("SELECT * FROM audit_log WHERE action = 'auth.logout'")
      .all() as Array<{ user_id: string | null; action: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.user_id).toBe("uuid-7");
  });

  it("audits with null userId for an anonymous logout call", async () => {
    const caller = appRouter.createCaller({ req: makeReq(), userId: null });
    await caller.auth.logout();
    const rows = db
      .prepare("SELECT * FROM audit_log WHERE action = 'auth.logout'")
      .all() as Array<{ user_id: string | null }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.user_id).toBeNull();
  });
});
