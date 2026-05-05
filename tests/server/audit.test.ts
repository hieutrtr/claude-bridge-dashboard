// T04 — appendAudit helper. Test seam: __setAuditDb(db) + __resetAudit()
// so we can inject a fresh in-memory DB per test.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import {
  __resetAudit,
  __setAuditDb,
  appendAudit,
} from "../../src/server/audit";
import { runMigrations } from "../../src/server/migrate";

const ORIGINAL_ENV = { ...process.env };

function setEnv(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
}

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

let db: Database;

beforeEach(() => {
  // Audit module config is salt-derived; reset env between tests.
  setEnv({
    AUDIT_IP_HASH_SALT: undefined,
    JWT_SECRET: undefined,
  });
  db = new Database(":memory:");
  runMigrations(db);
  __resetAudit();
  __setAuditDb(db);
});

afterEach(() => {
  __setAuditDb(null);
  __resetAudit();
  db.close();
  setEnv({
    AUDIT_IP_HASH_SALT: ORIGINAL_ENV.AUDIT_IP_HASH_SALT,
    JWT_SECRET: ORIGINAL_ENV.JWT_SECRET,
  });
});

describe("appendAudit — basic insert", () => {
  it("inserts a row matching the inputs", () => {
    const before = Date.now();
    const r = appendAudit({
      action: "task.dispatch",
      resourceType: "task",
      resourceId: "42",
      userId: "owner",
      payload: { agent: "x" },
    });
    const after = Date.now();
    expect(r.id).toBeGreaterThan(0);
    expect(r.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0].action).toBe("task.dispatch");
    expect(all[0].resource_type).toBe("task");
    expect(all[0].resource_id).toBe("42");
    expect(all[0].user_id).toBe("owner");
    expect(all[0].payload_json).toBe(JSON.stringify({ agent: "x" }));
    expect(all[0].request_id).toBe(r.requestId);
    expect(all[0].created_at).toBeGreaterThanOrEqual(before);
    expect(all[0].created_at).toBeLessThanOrEqual(after);
  });

  it("nullable fields default to null when not supplied", () => {
    appendAudit({ action: "x", resourceType: "y" });
    const r = rows(db)[0];
    expect(r.user_id).toBeNull();
    expect(r.resource_id).toBeNull();
    expect(r.payload_json).toBeNull();
    expect(r.ip_hash).toBeNull();
    expect(r.user_agent).toBeNull();
  });

  it("explicit requestId takes priority over auto-generation", () => {
    const fixed = "11111111-2222-3333-4444-555555555555";
    const r = appendAudit({
      action: "x",
      resourceType: "y",
      requestId: fixed,
    });
    expect(r.requestId).toBe(fixed);
    expect(rows(db)[0].request_id).toBe(fixed);
  });
});

describe("appendAudit — IP hashing", () => {
  function reqWithXff(ip: string, ua?: string): Request {
    const headers: Record<string, string> = {};
    headers["x-forwarded-for"] = ip;
    if (ua) headers["user-agent"] = ua;
    return new Request("http://localhost/anything", { headers });
  }

  async function expectedHash(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return base64UrlEncode(new Uint8Array(digest));
  }

  function base64UrlEncode(bytes: Uint8Array): string {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  }

  it("uses AUDIT_IP_HASH_SALT when set", async () => {
    setEnv({ AUDIT_IP_HASH_SALT: "s" });
    appendAudit({
      action: "x",
      resourceType: "y",
      req: reqWithXff("1.2.3.4"),
    });
    const expected = await expectedHash("1.2.3.4:s");
    expect(rows(db)[0].ip_hash).toBe(expected);
  });

  it("falls back to JWT_SECRET when AUDIT_IP_HASH_SALT is unset", async () => {
    setEnv({ AUDIT_IP_HASH_SALT: undefined, JWT_SECRET: "js" });
    appendAudit({
      action: "x",
      resourceType: "y",
      req: reqWithXff("1.2.3.4"),
    });
    const expected = await expectedHash("1.2.3.4:js");
    expect(rows(db)[0].ip_hash).toBe(expected);
  });

  it("ip_hash is null when no salt is configured", () => {
    setEnv({ AUDIT_IP_HASH_SALT: undefined, JWT_SECRET: undefined });
    appendAudit({
      action: "x",
      resourceType: "y",
      req: reqWithXff("1.2.3.4"),
    });
    expect(rows(db)[0].ip_hash).toBeNull();
  });

  it("ip_hash is null when no IP can be derived from the request", () => {
    setEnv({ AUDIT_IP_HASH_SALT: "s" });
    appendAudit({
      action: "x",
      resourceType: "y",
      req: new Request("http://localhost/", {}),
    });
    expect(rows(db)[0].ip_hash).toBeNull();
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    setEnv({ AUDIT_IP_HASH_SALT: "s" });
    const req = new Request("http://localhost/", {
      headers: { "x-real-ip": "5.6.7.8" },
    });
    appendAudit({ action: "x", resourceType: "y", req });
    const expected = await expectedHash("5.6.7.8:s");
    expect(rows(db)[0].ip_hash).toBe(expected);
  });

  it("uses first hop of x-forwarded-for", async () => {
    setEnv({ AUDIT_IP_HASH_SALT: "s" });
    const req = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "1.2.3.4, 9.9.9.9, 8.8.8.8" },
    });
    appendAudit({ action: "x", resourceType: "y", req });
    const expected = await expectedHash("1.2.3.4:s");
    expect(rows(db)[0].ip_hash).toBe(expected);
  });
});

describe("appendAudit — payload sanitisation", () => {
  it("redacts top-level `password` keys", () => {
    appendAudit({
      action: "auth.login",
      resourceType: "auth",
      payload: { user: "owner", password: "hunter2" },
    });
    const r = rows(db)[0];
    expect(r.payload_json).toBeDefined();
    const parsed = JSON.parse(r.payload_json!);
    expect(parsed.password).toBe("<redacted>");
    expect(parsed.user).toBe("owner");
  });

  it("records null payload_json when JSON.stringify throws", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    appendAudit({ action: "x", resourceType: "y", payload: cyc });
    expect(rows(db)[0].payload_json).toBeNull();
  });

  it("explicit null payload writes null", () => {
    appendAudit({ action: "x", resourceType: "y", payload: null });
    expect(rows(db)[0].payload_json).toBeNull();
  });
});

describe("appendAudit — user_agent truncation", () => {
  it("truncates UA header to 256 chars", () => {
    const longUa = "A".repeat(1000);
    const req = new Request("http://localhost/", {
      headers: { "user-agent": longUa },
    });
    appendAudit({ action: "x", resourceType: "y", req });
    const r = rows(db)[0];
    expect(r.user_agent).toBeDefined();
    expect(r.user_agent!.length).toBe(256);
    expect(r.user_agent).toBe("A".repeat(256));
  });
});

describe("appendAudit — failure resilience", () => {
  it("does not throw when the underlying DB is unavailable", () => {
    db.close();
    expect(() =>
      appendAudit({ action: "x", resourceType: "y" }),
    ).not.toThrow();
  });
});
