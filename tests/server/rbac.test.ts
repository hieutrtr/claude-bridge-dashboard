// P4-T03 — RBAC helper unit tests.
//
// Coverage:
//   * `resolveCaller` — anonymous / unknown sub / env-owner / member /
//     owner / revoked all surface the right tagged role.
//   * `requireAuth` — 401 for anon/unknown/revoked; returns the row
//     for member + owner.
//   * `requireOwner` — 401 for anon/unknown, 403 for member, returns
//     the row for owner.
//   * `requireOwnerOrSelf` — owner always allowed; member allowed for
//     own resource OR `resourceUserId === null`; member forbidden when
//     resource belongs to another user. 401 for anonymous.
//   * Audit shape — `rbac_denied` row fields match the contract used
//     by the existing `users.*` router tests (T02 audit shape is the
//     central contract; T03 must not break it).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";

import {
  requireAuth,
  requireOwner,
  requireOwnerOrSelf,
  resolveCaller,
} from "../../src/server/rbac";
import { resetDb, getSqlite } from "../../src/server/db";
import { __resetAudit, __setAuditDb } from "../../src/server/audit";

let tmpDir: string;
let dbPath: string;
let db: Database;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.JWT_SECRET = "rbac-test-secret";
  process.env.AUDIT_IP_HASH_SALT = "rbac-test-salt";
  tmpDir = mkdtempSync(join(tmpdir(), "rbac-test-"));
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

interface SeedOpts {
  id: string;
  email: string;
  role?: "owner" | "member";
  revokedAt?: number | null;
}

function seedUser(opts: SeedOpts): void {
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

interface AuditRow {
  action: string;
  resource_type: string;
  user_id: string | null;
  payload_json: string | null;
}

function readAudit(): AuditRow[] {
  return db
    .prepare(
      `SELECT action, resource_type, user_id, payload_json
         FROM audit_log ORDER BY id ASC`,
    )
    .all() as AuditRow[];
}

describe("resolveCaller", () => {
  it("returns role:anonymous for missing userId", () => {
    expect(resolveCaller({ userId: null })).toEqual({
      role: "anonymous",
      user: null,
      sub: null,
    });
    expect(resolveCaller({})).toMatchObject({ role: "anonymous", user: null });
  });

  it("returns role:owner with synthetic env-owner row for sub=owner", () => {
    process.env.OWNER_EMAIL = "boss@example.com";
    const c = resolveCaller({ userId: "owner" });
    expect(c.role).toBe("owner");
    expect(c.user).not.toBeNull();
    expect(c.user!.email).toBe("boss@example.com");
    expect(c.user!.id).toBe("owner");
  });

  it("returns role:unknown for a sub that does NOT match a users row (and is not owner)", () => {
    const c = resolveCaller({ userId: "ghost-uuid" });
    expect(c.role).toBe("unknown");
    expect(c.user).toBeNull();
    expect(c.sub).toBe("ghost-uuid");
  });

  it("returns role:member for a regular users row", () => {
    seedUser({ id: "u-mem", email: "m@example.com", role: "member" });
    const c = resolveCaller({ userId: "u-mem" });
    expect(c.role).toBe("member");
    expect(c.user!.id).toBe("u-mem");
  });

  it("returns role:owner for a users row whose role is 'owner'", () => {
    seedUser({ id: "u-own", email: "o@example.com", role: "owner" });
    const c = resolveCaller({ userId: "u-own" });
    expect(c.role).toBe("owner");
    expect(c.user!.id).toBe("u-own");
  });

  it("treats a revoked user as unknown (resolveSessionUser returns null)", () => {
    seedUser({
      id: "u-rev",
      email: "r@example.com",
      role: "owner",
      revokedAt: Date.now(),
    });
    const c = resolveCaller({ userId: "u-rev" });
    expect(c.role).toBe("unknown");
    expect(c.user).toBeNull();
  });
});

describe("requireAuth", () => {
  it("throws UNAUTHORIZED + audits rbac_denied for anonymous", () => {
    let caught: TRPCError | null = null;
    try {
      requireAuth({ userId: null }, "tasks.dispatch");
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("UNAUTHORIZED");
    const rows = readAudit();
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("rbac_denied");
    expect(rows[0]!.resource_type).toBe("tasks.dispatch");
    expect(rows[0]!.user_id).toBeNull();
    expect(JSON.parse(rows[0]!.payload_json!)).toMatchObject({
      requiredRole: "authenticated",
      callerRole: "anonymous",
    });
  });

  it("throws UNAUTHORIZED for an unknown sub (records sub on the audit row)", () => {
    expect(() =>
      requireAuth({ userId: "ghost" }, "tasks.kill"),
    ).toThrow();
    const rows = readAudit();
    expect(rows[0]!.user_id).toBe("ghost");
    expect(JSON.parse(rows[0]!.payload_json!).callerRole).toBe("unknown");
  });

  it("returns the user row for env-owner", () => {
    const u = requireAuth({ userId: "owner" }, "tasks.dispatch");
    expect(u.id).toBe("owner");
    expect(u.role).toBe("owner");
    expect(readAudit().length).toBe(0);
  });

  it("returns the user row for a regular member", () => {
    seedUser({ id: "u-mem", email: "m@example.com", role: "member" });
    const u = requireAuth({ userId: "u-mem" }, "tasks.dispatch");
    expect(u.id).toBe("u-mem");
    expect(u.role).toBe("member");
    expect(readAudit().length).toBe(0);
  });
});

describe("requireOwner", () => {
  it("throws UNAUTHORIZED for anonymous + audits rbac_denied", () => {
    expect(() => requireOwner({ userId: null }, "users.list")).toThrow();
    const rows = readAudit();
    expect(rows[0]!.resource_type).toBe("users.list");
    expect(JSON.parse(rows[0]!.payload_json!)).toMatchObject({
      requiredRole: "owner",
      callerRole: "anonymous",
    });
  });

  it("throws FORBIDDEN for member + audits rbac_denied", () => {
    seedUser({ id: "u-mem", email: "m@example.com", role: "member" });
    let caught: TRPCError | null = null;
    try {
      requireOwner({ userId: "u-mem" }, "users.invite");
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("FORBIDDEN");
    const rows = readAudit();
    expect(rows[0]!.user_id).toBe("u-mem");
    expect(JSON.parse(rows[0]!.payload_json!)).toMatchObject({
      requiredRole: "owner",
      callerRole: "member",
    });
  });

  it("returns the row for owner", () => {
    seedUser({ id: "u-own", email: "o@example.com", role: "owner" });
    const u = requireOwner({ userId: "u-own" }, "users.list");
    expect(u.id).toBe("u-own");
    expect(readAudit().length).toBe(0);
  });

  it("returns the synthetic env-owner row for sub=owner", () => {
    const u = requireOwner({ userId: "owner" }, "users.list");
    expect(u.role).toBe("owner");
    expect(readAudit().length).toBe(0);
  });
});

describe("requireOwnerOrSelf", () => {
  it("returns owner row for owner caller (any resourceUserId)", () => {
    seedUser({ id: "u-own", email: "o@example.com", role: "owner" });
    const u = requireOwnerOrSelf({
      ctx: { userId: "u-own" },
      route: "tasks.kill",
      resourceUserId: "someone-else",
    });
    expect(u.id).toBe("u-own");
    expect(readAudit().length).toBe(0);
  });

  it("allows member when resourceUserId === caller.id", () => {
    seedUser({ id: "u-mem", email: "m@example.com", role: "member" });
    const u = requireOwnerOrSelf({
      ctx: { userId: "u-mem" },
      route: "tasks.kill",
      resourceUserId: "u-mem",
    });
    expect(u.id).toBe("u-mem");
    expect(readAudit().length).toBe(0);
  });

  it("allows member on legacy NULL user_id rows (CLI carve-out)", () => {
    seedUser({ id: "u-mem", email: "m@example.com", role: "member" });
    const u = requireOwnerOrSelf({
      ctx: { userId: "u-mem" },
      route: "tasks.kill",
      resourceUserId: null,
    });
    expect(u.id).toBe("u-mem");
    expect(readAudit().length).toBe(0);
  });

  it("throws FORBIDDEN when member acts on another user's resource", () => {
    seedUser({ id: "u-mem", email: "m@example.com", role: "member" });
    let caught: TRPCError | null = null;
    try {
      requireOwnerOrSelf({
        ctx: { userId: "u-mem" },
        route: "tasks.kill",
        resourceUserId: "someone-else",
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("FORBIDDEN");
    const rows = readAudit();
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("rbac_denied");
    expect(rows[0]!.resource_type).toBe("tasks.kill");
    expect(rows[0]!.user_id).toBe("u-mem");
    const payload = JSON.parse(rows[0]!.payload_json!);
    expect(payload).toMatchObject({
      requiredRole: "owner_or_self",
      callerRole: "member",
      resourceUserId: "someone-else",
    });
  });

  it("throws UNAUTHORIZED for anonymous (and audits rbac_denied as 'authenticated' required)", () => {
    let caught: TRPCError | null = null;
    try {
      requireOwnerOrSelf({
        ctx: { userId: null },
        route: "tasks.kill",
        resourceUserId: "u-other",
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("UNAUTHORIZED");
    const rows = readAudit();
    expect(rows.length).toBe(1);
    // The audit row reflects the requireAuth gate (authenticated), not
    // the owner_or_self gate, because the caller never made it past
    // the auth check. This matches the layered-guard behaviour the
    // matrix test relies on.
    expect(JSON.parse(rows[0]!.payload_json!).requiredRole).toBe(
      "authenticated",
    );
  });
});
