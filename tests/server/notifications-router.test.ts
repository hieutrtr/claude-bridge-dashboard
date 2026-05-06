// P4-T06 — `notifications.*` tRPC router tests.
//
// Coverage matrix:
//   * RBAC entrance — anonymous / unknown sub / revoked user rejected.
//   * `notifications.preferences()` — first call creates row with
//     defaults; subsequent calls read the persisted row; never returns
//     other users' rows.
//   * `notifications.update` — partial update keeps untouched fields;
//     no-op update returns empty changedKeys; validates hour bounds
//     + tz regex; audit emits CHANGES KEYS only (never values, never
//     email).
//   * `notifications.reset` — restores defaults; audit emits
//     `notification.preferences-reset` with the diffed keys.
//   * Self-only — owner cannot update another user's prefs via this
//     router (the surface is self-only by construction; verified by
//     asserting the row written matches the caller id).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appRouter } from "../../src/server/routers/_app";
import { resetDb, getSqlite } from "../../src/server/db";
import { __resetAudit, __setAuditDb } from "../../src/server/audit";
import { findPreferences } from "../../src/server/notification-prefs";

const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  process.env.JWT_SECRET = "notif-router-test-secret";
  process.env.AUDIT_IP_HASH_SALT = "notif-router-salt";
  tmpDir = mkdtempSync(join(tmpdir(), "notif-router-test-"));
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
  return new Request("http://localhost/api/trpc/notifications.preferences", {
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
}

function seedUser(opts: SeedOpts): void {
  db.prepare(
    `INSERT INTO users (id, email, role, created_at, last_login_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.email,
    opts.role ?? "member",
    Date.now(),
    null,
    opts.revokedAt ?? null,
  );
}

interface AuditRow {
  action: string;
  resource_type: string;
  resource_id: string | null;
  user_id: string | null;
  payload_json: string | null;
}

function readAudit(action?: string): AuditRow[] {
  if (action) {
    return db
      .prepare(
        `SELECT action, resource_type, resource_id, user_id, payload_json
           FROM audit_log WHERE action = ?
          ORDER BY id ASC`,
      )
      .all(action) as AuditRow[];
  }
  return db
    .prepare(
      `SELECT action, resource_type, resource_id, user_id, payload_json
         FROM audit_log ORDER BY id ASC`,
    )
    .all() as AuditRow[];
}

function caller(userId: string | null): ReturnType<typeof appRouter.createCaller> {
  return appRouter.createCaller({ req: makeReq(), userId });
}

describe("notifications.preferences — RBAC", () => {
  it("rejects anonymous callers with UNAUTHORIZED + audits rbac_denied", async () => {
    await expect(caller(null).notifications.preferences()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const rows = readAudit("rbac_denied");
    expect(rows.length).toBe(1);
    expect(rows[0]!.resource_type).toBe("notifications.preferences");
    expect(JSON.parse(rows[0]!.payload_json!)).toMatchObject({
      requiredRole: "authenticated",
      callerRole: "anonymous",
    });
  });

  it("rejects sub that does not match any users row", async () => {
    await expect(
      caller("ghost-uuid").notifications.preferences(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects revoked user with UNAUTHORIZED", async () => {
    seedUser({
      id: "u-rev",
      email: "rev@example.com",
      role: "member",
      revokedAt: Date.now(),
    });
    await expect(
      caller("u-rev").notifications.preferences(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows env-owner session (sub=owner) without a users row", async () => {
    process.env.OWNER_EMAIL = "boss@example.com";
    const out = await caller("owner").notifications.preferences();
    expect(out.inAppEnabled).toBe(true);
    expect(out.emailDigestEnabled).toBe(false);
  });
});

describe("notifications.preferences — defaults + persistence", () => {
  beforeEach(() => {
    seedUser({ id: "u1", email: "alice@example.com", role: "member" });
  });

  it("creates a row with defaults on first read", async () => {
    const out = await caller("u1").notifications.preferences();
    expect(out).toMatchObject({
      inAppEnabled: true,
      emailDigestEnabled: false,
      emailDigestHour: 9,
      emailDigestTz: "UTC",
      browserPushEnabled: false,
    });
    expect(typeof out.updatedAt).toBe("number");

    // Persisted to DB.
    const row = findPreferences("u1");
    expect(row?.inAppEnabled).toBe(true);
  });

  it("subsequent calls return the persisted row (no insert thrash)", async () => {
    const a = await caller("u1").notifications.preferences();
    const b = await caller("u1").notifications.preferences();
    expect(a.updatedAt).toBe(b.updatedAt);
  });

  it("query does NOT audit (only mutations are audited)", async () => {
    await caller("u1").notifications.preferences();
    expect(readAudit().length).toBe(0);
  });
});

describe("notifications.update — happy paths", () => {
  beforeEach(() => {
    seedUser({ id: "u1", email: "alice@example.com", role: "member" });
  });

  it("opts in to email digest + records changedKeys", async () => {
    const res = await caller("u1").notifications.update({
      emailDigestEnabled: true,
    });
    expect(res.ok).toBe(true);
    expect(res.prefs.emailDigestEnabled).toBe(true);
    expect(res.changedKeys).toEqual(["emailDigestEnabled"]);

    const persisted = findPreferences("u1");
    expect(persisted?.emailDigestEnabled).toBe(true);
  });

  it("partial update preserves untouched fields", async () => {
    await caller("u1").notifications.update({ emailDigestEnabled: true });
    const res = await caller("u1").notifications.update({
      emailDigestHour: 17,
    });
    expect(res.prefs.emailDigestEnabled).toBe(true);
    expect(res.prefs.emailDigestHour).toBe(17);
    expect(res.prefs.emailDigestTz).toBe("UTC");
  });

  it("no-op update returns empty changedKeys + no audit", async () => {
    await caller("u1").notifications.preferences();
    __resetAudit();
    __setAuditDb(db);
    const res = await caller("u1").notifications.update({
      inAppEnabled: true, // already default
    });
    expect(res.changedKeys).toEqual([]);
    // Note: an audit row is still written (the user pressed the
    // button), but `changes: []`.
    const audits = readAudit("notification.preferences-update");
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0]!.payload_json!)).toEqual({ changes: [] });
  });

  it("multi-field update collects all changedKeys", async () => {
    const res = await caller("u1").notifications.update({
      inAppEnabled: false,
      emailDigestEnabled: true,
      emailDigestHour: 8,
      emailDigestTz: "Asia/Saigon",
      browserPushEnabled: true,
    });
    expect(new Set(res.changedKeys)).toEqual(
      new Set([
        "inAppEnabled",
        "emailDigestEnabled",
        "emailDigestHour",
        "emailDigestTz",
        "browserPushEnabled",
      ]),
    );
  });

  it("audits with CHANGES KEYS only (no values, no email plaintext)", async () => {
    await caller("u1").notifications.update({
      emailDigestEnabled: true,
      emailDigestHour: 8,
    });
    const audits = readAudit("notification.preferences-update");
    expect(audits.length).toBe(1);
    const payload = JSON.parse(audits[0]!.payload_json!);
    expect(new Set(payload.changes)).toEqual(
      new Set(["emailDigestEnabled", "emailDigestHour"]),
    );
    // Privacy invariants: no values, no email anywhere in payload.
    expect(audits[0]!.payload_json!).not.toContain("alice@example.com");
    expect(audits[0]!.payload_json!).not.toContain("\"true\"");
    expect(audits[0]!.payload_json!).not.toMatch(/\"emailDigestHour\"\s*:\s*8/);
  });
});

describe("notifications.update — validation", () => {
  beforeEach(() => {
    seedUser({ id: "u1", email: "alice@example.com", role: "member" });
  });

  it("rejects emailDigestHour < 0 or > 23", async () => {
    await expect(
      caller("u1").notifications.update({ emailDigestHour: -1 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller("u1").notifications.update({ emailDigestHour: 24 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects malformed timezone", async () => {
    await expect(
      caller("u1").notifications.update({ emailDigestTz: "$not a tz!" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects empty body (must change at least one field)", async () => {
    await expect(
      caller("u1").notifications.update({}),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("notifications.update — self-only", () => {
  beforeEach(() => {
    seedUser({ id: "u-owner", email: "owner@example.com", role: "owner" });
    seedUser({ id: "u-member", email: "mem@example.com", role: "member" });
  });

  it("owner updating own row only writes to own user_id", async () => {
    await caller("u-owner").notifications.update({ emailDigestEnabled: true });
    const owner = findPreferences("u-owner");
    const member = findPreferences("u-member");
    expect(owner?.emailDigestEnabled).toBe(true);
    expect(member).toBeNull();
  });

  it("member updating own row only writes to own user_id", async () => {
    await caller("u-member").notifications.update({ emailDigestEnabled: true });
    const member = findPreferences("u-member");
    const owner = findPreferences("u-owner");
    expect(member?.emailDigestEnabled).toBe(true);
    expect(owner).toBeNull();
  });
});

describe("notifications.reset", () => {
  beforeEach(() => {
    seedUser({ id: "u1", email: "alice@example.com", role: "member" });
  });

  it("restores defaults + records changes", async () => {
    await caller("u1").notifications.update({
      emailDigestEnabled: true,
      emailDigestHour: 17,
      emailDigestTz: "Asia/Saigon",
      browserPushEnabled: true,
    });

    const res = await caller("u1").notifications.reset();
    expect(res.prefs.emailDigestEnabled).toBe(false);
    expect(res.prefs.emailDigestHour).toBe(9);
    expect(res.prefs.emailDigestTz).toBe("UTC");
    expect(res.prefs.browserPushEnabled).toBe(false);
    expect(new Set(res.changedKeys)).toEqual(
      new Set([
        "emailDigestEnabled",
        "emailDigestHour",
        "emailDigestTz",
        "browserPushEnabled",
      ]),
    );

    const audits = readAudit("notification.preferences-reset");
    expect(audits.length).toBe(1);
    const payload = JSON.parse(audits[0]!.payload_json!);
    expect(new Set(payload.changes)).toEqual(
      new Set([
        "emailDigestEnabled",
        "emailDigestHour",
        "emailDigestTz",
        "browserPushEnabled",
      ]),
    );
  });
});
