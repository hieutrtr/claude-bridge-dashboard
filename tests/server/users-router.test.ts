// P4-T02 — `users.*` tRPC router tests.
//
// Coverage matrix:
//   * RBAC entrance — anonymous / unknown sub / member-role / revoked
//     owner all rejected; rbac_denied audit row written for each.
//   * `users.list` — sort order, revoked rows hidden, returns plaintext
//     emails (UI requires them; the privacy boundary is the audit log).
//   * `users.invite` — new row, idempotent against existing row, re-
//     activates revoked row, audit emits emailHash never plaintext.
//   * `users.revoke` — happy path, self-revoke blocked, NOT_FOUND on
//     unknown id, idempotent on already-revoked.
//   * `users.changeRole` — promote/demote, no-op when same role,
//     last-owner gate (incl. self-demote), 4xx on unknown / revoked.
//   * Audit invariant — no audit payload contains the plaintext email.

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
  process.env.JWT_SECRET = "users-router-test-secret";
  process.env.AUDIT_IP_HASH_SALT = "users-router-salt";
  tmpDir = mkdtempSync(join(tmpdir(), "users-router-test-"));
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
  return new Request("http://localhost/api/trpc/users.list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

interface SeedOpts {
  id: string;
  email: string;
  role?: "owner" | "member";
  revokedAt?: number | null;
  lastLoginAt?: number | null;
  createdAt?: number;
}

function seedUser(opts: SeedOpts): void {
  db.prepare(
    `INSERT INTO users (id, email, role, created_at, last_login_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.email,
    opts.role ?? "member",
    opts.createdAt ?? Date.now(),
    opts.lastLoginAt ?? null,
    opts.revokedAt ?? null,
  );
}

interface AuditPayload {
  action: string;
  resource_type: string;
  resource_id: string | null;
  user_id: string | null;
  payload_json: string | null;
}

function readAudit(action?: string): AuditPayload[] {
  if (action) {
    return db
      .prepare(
        `SELECT action, resource_type, resource_id, user_id, payload_json
           FROM audit_log WHERE action = ?
          ORDER BY id ASC`,
      )
      .all(action) as AuditPayload[];
  }
  return db
    .prepare(
      `SELECT action, resource_type, resource_id, user_id, payload_json
         FROM audit_log ORDER BY id ASC`,
    )
    .all() as AuditPayload[];
}

function ownerCaller(id = "owner"): ReturnType<typeof appRouter.createCaller> {
  return appRouter.createCaller({ req: makeReq(), userId: id });
}

function memberCaller(id: string): ReturnType<typeof appRouter.createCaller> {
  return appRouter.createCaller({ req: makeReq(), userId: id });
}

function anonCaller(): ReturnType<typeof appRouter.createCaller> {
  return appRouter.createCaller({ req: makeReq(), userId: null });
}

describe("users.list — RBAC", () => {
  it("rejects anonymous callers with UNAUTHORIZED + audits rbac_denied", async () => {
    await expect(anonCaller().users.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const rows = readAudit("rbac_denied");
    expect(rows.length).toBe(1);
    expect(rows[0]!.resource_type).toBe("users.list");
    expect(rows[0]!.user_id).toBeNull();
    expect(JSON.parse(rows[0]!.payload_json!)).toMatchObject({
      requiredRole: "owner",
      callerRole: "anonymous",
    });
  });

  it("rejects callers with sub that does not match a user", async () => {
    await expect(
      memberCaller("ghost-uuid").users.list(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const rows = readAudit("rbac_denied");
    expect(rows.length).toBe(1);
    expect(rows[0]!.user_id).toBe("ghost-uuid");
    expect(JSON.parse(rows[0]!.payload_json!).callerRole).toBe("unknown");
  });

  it("rejects member callers with FORBIDDEN", async () => {
    seedUser({ id: "u-mem", email: "mem@example.com", role: "member" });
    await expect(
      memberCaller("u-mem").users.list(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rows = readAudit("rbac_denied");
    expect(rows.length).toBe(1);
    expect(rows[0]!.user_id).toBe("u-mem");
    expect(JSON.parse(rows[0]!.payload_json!).callerRole).toBe("member");
  });

  it("rejects revoked owner with UNAUTHORIZED", async () => {
    seedUser({
      id: "u-rev",
      email: "rev@example.com",
      role: "owner",
      revokedAt: Date.now(),
    });
    await expect(
      memberCaller("u-rev").users.list(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows env-owner session (sub=owner) without a users row", async () => {
    process.env.OWNER_EMAIL = "boss@example.com";
    const out = await ownerCaller().users.list();
    expect(Array.isArray(out)).toBe(true);
  });
});

describe("users.list — happy path", () => {
  it("returns active rows; hides revoked", async () => {
    seedUser({
      id: "u1",
      email: "alice@example.com",
      role: "owner",
      lastLoginAt: 2000,
      createdAt: 1000,
    });
    seedUser({
      id: "u2",
      email: "bob@example.com",
      role: "member",
      lastLoginAt: 3000,
      createdAt: 1000,
    });
    seedUser({
      id: "u3",
      email: "carol@example.com",
      role: "member",
      revokedAt: 5000,
      createdAt: 1000,
    });
    const out = await ownerCaller("u1").users.list();
    expect(out.length).toBe(2);
    expect(out[0]!.email).toBe("alice@example.com");
    expect(out[0]!.role).toBe("owner");
    expect(out[1]!.email).toBe("bob@example.com");
    expect(out[1]!.role).toBe("member");
  });

  it("does NOT write an audit row for the query (consistent with phase 2/3)", async () => {
    seedUser({ id: "u1", email: "a@b.com", role: "owner" });
    await ownerCaller("u1").users.list();
    const rows = readAudit();
    // No rows whatsoever — owner.list is a query, never audited.
    expect(rows.length).toBe(0);
  });
});

describe("users.invite", () => {
  it("creates a fresh row at the requested role + audits emailHash", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    const out = await ownerCaller("u-owner").users.invite({
      email: "new@example.com",
      role: "member",
    });
    expect(out).toMatchObject({ ok: true });
    expect(out.alreadyExisted).toBeUndefined();

    const row = db
      .prepare(`SELECT id, email, role FROM users WHERE email_lower = ?`)
      .get("new@example.com") as
      | { id: string; email: string; role: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.role).toBe("member");

    const audit = readAudit("user.invite");
    expect(audit.length).toBe(1);
    const payload = JSON.parse(audit[0]!.payload_json!) as Record<string, unknown>;
    expect(typeof payload.targetEmailHash).toBe("string");
    expect(payload.targetEmailHash).not.toContain("new@example.com");
    expect(payload.targetEmailHash).not.toContain("example");
  });

  it("invites at role=owner when explicitly requested", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    await ownerCaller("u-owner").users.invite({
      email: "second@example.com",
      role: "owner",
    });
    const row = db
      .prepare(`SELECT role FROM users WHERE email_lower = ?`)
      .get("second@example.com") as { role: string } | undefined;
    expect(row!.role).toBe("owner");
  });

  it("is idempotent against an existing active row (alreadyExisted=true)", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    seedUser({ id: "u-existing", email: "x@example.com", role: "member" });

    const out = await ownerCaller("u-owner").users.invite({
      email: "X@EXAMPLE.com",
      role: "owner", // ignored — existing row keeps its role
    });
    expect(out.alreadyExisted).toBe(true);

    const row = db
      .prepare(`SELECT role FROM users WHERE id = ?`)
      .get("u-existing") as { role: string };
    expect(row.role).toBe("member"); // not flipped to owner
  });

  it("re-activates a revoked row", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    seedUser({
      id: "u-rev",
      email: "ghost@example.com",
      role: "member",
      revokedAt: 99,
    });
    const out = await ownerCaller("u-owner").users.invite({
      email: "ghost@example.com",
      role: "owner",
    });
    expect(out.reactivated).toBe(true);
    const row = db
      .prepare(`SELECT role, revoked_at FROM users WHERE id = ?`)
      .get("u-rev") as { role: string; revoked_at: number | null };
    expect(row.role).toBe("owner");
    expect(row.revoked_at).toBeNull();
  });

  it("rejects member callers and audits rbac_denied", async () => {
    seedUser({ id: "u-mem", email: "mem@example.com", role: "member" });
    await expect(
      memberCaller("u-mem").users.invite({
        email: "x@example.com",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rows = readAudit("rbac_denied");
    expect(rows.length).toBe(1);
    expect(rows[0]!.resource_type).toBe("users.invite");
  });
});

describe("users.revoke", () => {
  it("soft-deletes a member; revoked rows drop from list", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    seedUser({ id: "u-target", email: "t@example.com", role: "member" });

    await ownerCaller("u-owner").users.revoke({ id: "u-target" });

    const row = db
      .prepare(`SELECT revoked_at FROM users WHERE id = ?`)
      .get("u-target") as { revoked_at: number | null };
    expect(row.revoked_at).not.toBeNull();

    const list = await ownerCaller("u-owner").users.list();
    expect(list.find((u) => u.id === "u-target")).toBeUndefined();

    const audit = readAudit("user.revoke");
    expect(audit.length).toBe(1);
    expect(audit[0]!.resource_id).toBe("u-target");
    const payload = JSON.parse(audit[0]!.payload_json!) as Record<string, unknown>;
    expect(payload.targetUserId).toBe("u-target");
    expect(payload).toHaveProperty("targetEmailHash");
    expect(JSON.stringify(payload)).not.toContain("t@example.com");
  });

  it("blocks self-revoke with BAD_REQUEST", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    await expect(
      ownerCaller("u-owner").users.revoke({ id: "u-owner" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const audit = readAudit("user.revoke.error");
    expect(audit.length).toBe(1);
    const payload = JSON.parse(audit[0]!.payload_json!) as Record<string, unknown>;
    expect(payload.code).toBe("self_revoke_blocked");
  });

  it("returns NOT_FOUND for an unknown id", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    await expect(
      ownerCaller("u-owner").users.revoke({ id: "ghost" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("is idempotent on already-revoked target (alreadyApplied=true)", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    seedUser({
      id: "u-old",
      email: "old@example.com",
      role: "member",
      revokedAt: 1234,
    });
    const out = await ownerCaller("u-owner").users.revoke({ id: "u-old" });
    expect(out.alreadyApplied).toBe(true);
    // revoked_at must NOT be overwritten (audit forensics rely on it).
    const row = db
      .prepare(`SELECT revoked_at FROM users WHERE id = ?`)
      .get("u-old") as { revoked_at: number };
    expect(row.revoked_at).toBe(1234);
  });

  it("rejects member callers", async () => {
    seedUser({ id: "u-mem", email: "mem@example.com", role: "member" });
    seedUser({ id: "u-target", email: "t@example.com", role: "member" });
    await expect(
      memberCaller("u-mem").users.revoke({ id: "u-target" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("users.changeRole", () => {
  it("promotes a member to owner + audits oldRole/newRole", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    seedUser({ id: "u-mem", email: "m@example.com", role: "member" });

    await ownerCaller("u-owner").users.changeRole({
      id: "u-mem",
      role: "owner",
    });

    const row = db
      .prepare(`SELECT role FROM users WHERE id = ?`)
      .get("u-mem") as { role: string };
    expect(row.role).toBe("owner");

    const audit = readAudit("user.role-change");
    expect(audit.length).toBe(1);
    const payload = JSON.parse(audit[0]!.payload_json!) as Record<string, unknown>;
    expect(payload.oldRole).toBe("member");
    expect(payload.newRole).toBe("owner");
    expect(payload).toHaveProperty("targetEmailHash");
  });

  it("demotes an owner when another owner exists", async () => {
    seedUser({ id: "u1", email: "a@example.com", role: "owner" });
    seedUser({ id: "u2", email: "b@example.com", role: "owner" });

    await ownerCaller("u1").users.changeRole({ id: "u2", role: "member" });

    const row = db
      .prepare(`SELECT role FROM users WHERE id = ?`)
      .get("u2") as { role: string };
    expect(row.role).toBe("member");
  });

  it("blocks demoting the last owner (incl. self) with BAD_REQUEST", async () => {
    seedUser({ id: "u-only", email: "only@example.com", role: "owner" });

    await expect(
      ownerCaller("u-only").users.changeRole({
        id: "u-only",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // role must remain owner
    const row = db
      .prepare(`SELECT role FROM users WHERE id = ?`)
      .get("u-only") as { role: string };
    expect(row.role).toBe("owner");

    const audit = readAudit("user.role-change.error");
    expect(audit.length).toBe(1);
    const payload = JSON.parse(audit[0]!.payload_json!) as Record<string, unknown>;
    expect(payload.code).toBe("last_owner");
    expect(payload.activeOwners).toBe(1);
  });

  it("blocks demoting the last owner even when other owners are revoked", async () => {
    seedUser({ id: "u-active", email: "a@example.com", role: "owner" });
    seedUser({
      id: "u-rev",
      email: "r@example.com",
      role: "owner",
      revokedAt: 99,
    });

    await expect(
      ownerCaller("u-active").users.changeRole({
        id: "u-active",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns alreadyApplied for same-role no-op", async () => {
    seedUser({ id: "u1", email: "a@example.com", role: "owner" });
    seedUser({ id: "u2", email: "b@example.com", role: "member" });
    const out = await ownerCaller("u1").users.changeRole({
      id: "u2",
      role: "member",
    });
    expect(out.alreadyApplied).toBe(true);
  });

  it("returns NOT_FOUND for unknown id", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    await expect(
      ownerCaller("u-owner").users.changeRole({
        id: "ghost",
        role: "owner",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects role change against a revoked target", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    seedUser({
      id: "u-rev",
      email: "r@example.com",
      role: "member",
      revokedAt: 99,
    });
    await expect(
      ownerCaller("u-owner").users.changeRole({
        id: "u-rev",
        role: "owner",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects member callers", async () => {
    seedUser({ id: "u-mem", email: "m@example.com", role: "member" });
    seedUser({ id: "u-tgt", email: "t@example.com", role: "member" });
    await expect(
      memberCaller("u-mem").users.changeRole({
        id: "u-tgt",
        role: "owner",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("audit invariants (privacy)", () => {
  it("never includes plaintext email in any audit payload", async () => {
    seedUser({ id: "u-owner", email: "boss@example.com", role: "owner" });
    seedUser({ id: "u-tgt", email: "victim@example.com", role: "member" });

    await ownerCaller("u-owner").users.invite({
      email: "fresh@example.com",
      role: "member",
    });
    await ownerCaller("u-owner").users.changeRole({
      id: "u-tgt",
      role: "owner",
    });
    await ownerCaller("u-owner").users.revoke({ id: "u-tgt" });

    const all = readAudit();
    const dump = all.map((r) => r.payload_json ?? "").join("\n");
    expect(dump).not.toContain("victim@example.com");
    expect(dump).not.toContain("boss@example.com");
    expect(dump).not.toContain("fresh@example.com");
  });
});
