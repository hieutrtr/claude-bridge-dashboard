// P4-T11 — `telemetry.*` tRPC router tests.
//
// Coverage matrix:
//   * Default state — opt-in OFF; `optInStatus` reports false; counts
//     are zero.
//   * RBAC — `setOptIn` and `recent` are owner-only; `optInStatus`
//     and `record` are authenticated-but-any-role.
//   * `setOptIn` — flipping ON generates an install_id; flipping OFF
//     keeps the install_id; audit row records the boolean only.
//   * `record` — opt-in OFF → no rows inserted; opt-in ON + clean name
//     → row inserted with anon install_id (no user_id); PII inputs
//     return `dropped_pii` and DO NOT insert a row.
//   * `recent` — owner sees the rows; member is FORBIDDEN.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appRouter } from "../../src/server/routers/_app";
import { resetDb, getSqlite } from "../../src/server/db";
import { __resetAudit, __setAuditDb } from "../../src/server/audit";
import {
  getTelemetryOptIn,
  setTelemetryOptIn,
  getOrCreateInstallId,
} from "../../src/server/dashboard-meta";
import { TRPCError } from "@trpc/server";

const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let db: Database;

beforeEach(() => {
  process.env.JWT_SECRET = "telemetry-router-test-secret";
  process.env.AUDIT_IP_HASH_SALT = "telemetry-router-salt";
  tmpDir = mkdtempSync(join(tmpdir(), "telemetry-router-test-"));
  process.env.BRIDGE_DB = join(tmpDir, "bridge.db");
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
  return new Request("http://localhost/api/trpc/telemetry.setOptIn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

interface SeedOpts {
  id: string;
  email: string;
  role?: "owner" | "member";
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
    null,
  );
}

function caller(userId: string | null): ReturnType<typeof appRouter.createCaller> {
  return appRouter.createCaller({ req: makeReq(), userId });
}

interface AuditRow {
  action: string;
  resource_type: string;
  user_id: string | null;
  payload_json: string | null;
}

function readAudit(action: string): AuditRow[] {
  return db
    .prepare(
      `SELECT action, resource_type, user_id, payload_json
         FROM audit_log WHERE action = ?
        ORDER BY id ASC`,
    )
    .all(action) as AuditRow[];
}

describe("telemetry.optInStatus", () => {
  it("reports OFF by default + zero counts", async () => {
    seedUser({ id: "u-owner", email: "owner@bridge.dev", role: "owner" });
    const status = await caller("u-owner").telemetry.optInStatus();
    expect(status.enabled).toBe(false);
    expect(status.installId).toBeNull();
    expect(status.counts).toEqual({
      total: 0,
      pageView: 0,
      actionLatency: 0,
      featureUsed: 0,
    });
  });

  it("rejects anonymous callers", async () => {
    await expect(caller(null).telemetry.optInStatus()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("allows members to read the toggle (it is non-sensitive)", async () => {
    seedUser({ id: "u-mem", email: "m@bridge.dev", role: "member" });
    const status = await caller("u-mem").telemetry.optInStatus();
    expect(status.enabled).toBe(false);
  });
});

describe("telemetry.setOptIn", () => {
  it("FORBIDDEN for members", async () => {
    seedUser({ id: "u-mem", email: "m@bridge.dev", role: "member" });
    await expect(
      caller("u-mem").telemetry.setOptIn({ enabled: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getTelemetryOptIn(db)).toBe(false);
  });

  it("UNAUTHORIZED for anonymous", async () => {
    await expect(
      caller(null).telemetry.setOptIn({ enabled: true }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("flips the toggle ON for owner + generates install_id + audits", async () => {
    seedUser({ id: "u-own", email: "o@bridge.dev", role: "owner" });
    const out = await caller("u-own").telemetry.setOptIn({ enabled: true });
    expect(out.enabled).toBe(true);
    expect(out.changed).toBe(true);
    expect(typeof out.installId).toBe("string");
    expect((out.installId ?? "").length).toBeGreaterThanOrEqual(8);

    expect(getTelemetryOptIn(db)).toBe(true);

    const audits = readAudit("telemetry.opt-in-toggle");
    expect(audits.length).toBe(1);
    expect(audits[0]!.user_id).toBe("u-own");
    expect(audits[0]!.resource_type).toBe("telemetry");
    const payload = JSON.parse(audits[0]!.payload_json ?? "{}");
    expect(payload.enabled).toBe(true);
    expect(payload.changed).toBe(true);
    // Audit MUST NOT echo the install_id (privacy: anon identity).
    expect(audits[0]!.payload_json ?? "").not.toContain(out.installId ?? "x");
  });

  it("flipping ON twice is idempotent + reuses the same install_id", async () => {
    seedUser({ id: "u-own", email: "o@bridge.dev", role: "owner" });
    const a = await caller("u-own").telemetry.setOptIn({ enabled: true });
    const b = await caller("u-own").telemetry.setOptIn({ enabled: true });
    expect(a.installId).toBe(b.installId);
    expect(b.changed).toBe(false);
    expect(readAudit("telemetry.opt-in-toggle").length).toBe(2);
  });

  it("flipping OFF preserves the install_id (anonymous identity stable)", async () => {
    seedUser({ id: "u-own", email: "o@bridge.dev", role: "owner" });
    await caller("u-own").telemetry.setOptIn({ enabled: true });
    const id1 = getOrCreateInstallId(db);
    const off = await caller("u-own").telemetry.setOptIn({ enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.installId).toBeNull();
    // The DB still has the install_id row — flipping back ON recovers it.
    const id2 = getOrCreateInstallId(db);
    expect(id2).toBe(id1);
  });
});

describe("telemetry.record", () => {
  function rowCount(): number {
    return (
      db
        .prepare(`SELECT count(*) AS n FROM telemetry_events`)
        .get() as { n: number } | null
    )?.n ?? 0;
  }

  it("UNAUTHORIZED for anonymous", async () => {
    await expect(
      caller(null).telemetry.record({
        eventType: "page_view",
        eventName: "/agents",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns dropped_off when telemetry is OFF (no row inserted)", async () => {
    seedUser({ id: "u-mem", email: "m@bridge.dev", role: "member" });
    const out = await caller("u-mem").telemetry.record({
      eventType: "page_view",
      eventName: "/agents",
    });
    expect(out.status).toBe("dropped_off");
    expect(out.id).toBeNull();
    expect(rowCount()).toBe(0);
  });

  it("inserts a row when ON + clean event_name", async () => {
    seedUser({ id: "u-own", email: "o@bridge.dev", role: "owner" });
    seedUser({ id: "u-mem", email: "m@bridge.dev", role: "member" });
    setTelemetryOptIn(true, db);
    const out = await caller("u-mem").telemetry.record({
      eventType: "page_view",
      eventName: "/agents",
    });
    expect(out.status).toBe("accepted");
    expect(out.eventName).toBe("/agents");
    expect(rowCount()).toBe(1);

    const row = db
      .prepare(
        `SELECT install_id, event_type, event_name, value_ms FROM telemetry_events`,
      )
      .get() as {
        install_id: string;
        event_type: string;
        event_name: string;
        value_ms: number | null;
      };
    expect(row.event_type).toBe("page_view");
    expect(row.event_name).toBe("/agents");
    expect(row.value_ms).toBeNull();
    expect(typeof row.install_id).toBe("string");
    // Critical privacy check: NO user_id column on the row, and the
    // install_id must NOT match either user id.
    expect(row.install_id).not.toBe("u-own");
    expect(row.install_id).not.toBe("u-mem");
  });

  it("rewrites IDs in event_name before insert", async () => {
    seedUser({ id: "u-mem", email: "m@bridge.dev", role: "member" });
    setTelemetryOptIn(true, db);
    const out = await caller("u-mem").telemetry.record({
      eventType: "page_view",
      eventName: "/tasks/0123456789abcdef",
    });
    expect(out.status).toBe("accepted");
    expect(out.eventName).toBe("/tasks/[id]");
  });

  it("drops PII inputs without inserting", async () => {
    seedUser({ id: "u-mem", email: "m@bridge.dev", role: "member" });
    setTelemetryOptIn(true, db);
    const cases: Array<{ eventName: string; reason: string }> = [
      { eventName: "/users/jane@bridge.dev", reason: "email" },
      { eventName: "/health/127.0.0.1", reason: "ipv4" },
      { eventName: "/Users/op/.ssh/key", reason: "file_path" },
    ];
    for (const c of cases) {
      const out = await caller("u-mem").telemetry.record({
        eventType: "page_view",
        eventName: c.eventName,
      });
      expect(out.status).toBe("dropped_pii");
      expect(out.reason).toBe(c.reason);
    }
    expect(rowCount()).toBe(0);
  });

  it("strips a query string and accepts the path component", async () => {
    seedUser({ id: "u-mem", email: "m@bridge.dev", role: "member" });
    setTelemetryOptIn(true, db);
    const out = await caller("u-mem").telemetry.record({
      eventType: "page_view",
      eventName: "/cost?v=2",
    });
    // Query strings are not user-content per se — we strip them and
    // log only the path. (Embedded PII in the query that survives the
    // strip would still be caught by `containsPii`.)
    expect(out.status).toBe("accepted");
    expect(out.eventName).toBe("/cost");
  });

  it("never echoes the offending raw eventName in the response", async () => {
    seedUser({ id: "u-mem", email: "m@bridge.dev", role: "member" });
    setTelemetryOptIn(true, db);
    const out = await caller("u-mem").telemetry.record({
      eventType: "page_view",
      eventName: "/users/leak@bridge.dev",
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("leak@bridge.dev");
  });

  it("does NOT write an audit row for record (privacy)", async () => {
    seedUser({ id: "u-mem", email: "m@bridge.dev", role: "member" });
    setTelemetryOptIn(true, db);
    await caller("u-mem").telemetry.record({
      eventType: "page_view",
      eventName: "/agents",
    });
    // No audit action exists for record events. Only `telemetry.opt-in-toggle`
    // (from setOptIn) is in the log.
    const all = db
      .prepare(`SELECT action FROM audit_log`)
      .all() as Array<{ action: string }>;
    expect(all.find((r) => r.action.startsWith("telemetry.record"))).toBeUndefined();
  });
});

describe("telemetry.recent", () => {
  it("FORBIDDEN for members", async () => {
    seedUser({ id: "u-mem", email: "m@bridge.dev", role: "member" });
    await expect(
      caller("u-mem").telemetry.recent({ limit: 10 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns rows in descending id order for owner", async () => {
    seedUser({ id: "u-own", email: "o@bridge.dev", role: "owner" });
    seedUser({ id: "u-mem", email: "m@bridge.dev", role: "member" });
    setTelemetryOptIn(true, db);
    await caller("u-mem").telemetry.record({
      eventType: "page_view",
      eventName: "/a",
    });
    await caller("u-mem").telemetry.record({
      eventType: "feature_used",
      eventName: "cmdk.open",
    });
    const out = await caller("u-own").telemetry.recent({ limit: 10 });
    expect(out.events.length).toBe(2);
    expect(out.events[0]!.eventName).toBe("cmdk.open");
    expect(out.events[1]!.eventName).toBe("/a");
  });
});

describe("audit row never echoes the install_id", () => {
  it("setOptIn payload_json does not contain the install_id UUID", async () => {
    seedUser({ id: "u-own", email: "o@bridge.dev", role: "owner" });
    const out = await caller("u-own").telemetry.setOptIn({ enabled: true });
    const installId = out.installId!;
    const audits = readAudit("telemetry.opt-in-toggle");
    for (const a of audits) {
      expect(a.payload_json ?? "").not.toContain(installId);
    }
  });
});

// Smoke check that the test file actually wires the router — if the
// import path were stale this would fail with "Cannot read property
// telemetry of undefined" before any of the above runs.
describe("appRouter mounts telemetry", () => {
  it("exposes telemetry as a sub-router", () => {
    seedUser({ id: "u-anon-probe", email: "a@bridge.dev", role: "owner" });
    const c = caller("u-anon-probe");
    expect(typeof c.telemetry.optInStatus).toBe("function");
    expect(typeof c.telemetry.setOptIn).toBe("function");
    expect(typeof c.telemetry.record).toBe("function");
    expect(typeof c.telemetry.recent).toBe("function");
  });
});

void TRPCError;
