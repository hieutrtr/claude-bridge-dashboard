// T04 — integration: csrf-guard 403, rate-limit-mutations 429, and
// rate-limit-login 429 all append a row to audit_log. We use the
// globalThis-keyed test seam so freshModule() invocations share state.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import {
  __resetAudit,
  __setAuditDb,
} from "../../src/server/audit";
import { runMigrations } from "../../src/server/migrate";
import { CSRF_COOKIE, CSRF_HEADER } from "../../src/lib/csrf";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "audit-integration-secret-please-do-not-use-in-prod";

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
  setEnv({ JWT_SECRET: SECRET, AUDIT_IP_HASH_SALT: "salty" });
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
    JWT_SECRET: ORIGINAL_ENV.JWT_SECRET,
    AUDIT_IP_HASH_SALT: ORIGINAL_ENV.AUDIT_IP_HASH_SALT,
    RATE_LIMIT_MUTATIONS_PER_MIN: ORIGINAL_ENV.RATE_LIMIT_MUTATIONS_PER_MIN,
    RATE_LIMIT_LOGIN_PER_MIN: ORIGINAL_ENV.RATE_LIMIT_LOGIN_PER_MIN,
  });
});

describe("csrfGuard — audit on 403", () => {
  it("appends a csrf_invalid row on missing token", async () => {
    const { csrfGuard } = await import(
      `../../src/server/csrf-guard.ts?t=${Math.random()}`
    );
    const req = new Request("http://localhost/api/trpc/anything", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "1.2.3.4",
      },
      body: JSON.stringify({}),
    });
    const res = await csrfGuard(req);
    expect(res!.status).toBe(403);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0].action).toBe("csrf_invalid");
    expect(all[0].resource_type).toBe("auth");
    expect(all[0].user_id).toBeNull();
    expect(all[0].ip_hash).not.toBeNull();
    expect(all[0].request_id).not.toBeNull();
  });

  it("does not audit on safe methods", async () => {
    const { csrfGuard } = await import(
      `../../src/server/csrf-guard.ts?t=${Math.random()}`
    );
    expect(
      await csrfGuard(
        new Request("http://localhost/api/trpc/anything", { method: "GET" }),
      ),
    ).toBeNull();
    expect(rows(db).length).toBe(0);
  });
});

describe("rateLimitMutations — audit on 429", () => {
  it("appends a rate_limit_blocked row with user_id + retryAfterSec", async () => {
    setEnv({ RATE_LIMIT_MUTATIONS_PER_MIN: undefined });
    const m = await import(
      `../../src/server/rate-limit-mutations.ts?t=${Math.random()}`
    );
    m._reset();
    const make = () =>
      new Request("http://localhost/api/trpc/anything", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
        body: "{}",
      });
    for (let i = 0; i < 30; i++) {
      const r = await m.rateLimitMutations(make(), "u1");
      expect(r).toBeNull();
    }
    const denied = await m.rateLimitMutations(make(), "u1");
    expect(denied!.status).toBe(429);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0].action).toBe("rate_limit_blocked");
    expect(all[0].resource_type).toBe("mutation");
    expect(all[0].user_id).toBe("u1");
    expect(all[0].payload_json).not.toBeNull();
    const payload = JSON.parse(all[0].payload_json!);
    expect(typeof payload.retryAfterSec).toBe("number");
    expect(payload.retryAfterSec).toBeGreaterThan(0);
  });
});

describe("rateLimitLogin — audit on 429", () => {
  it("appends a rate_limit_blocked row with resource_type=auth", async () => {
    setEnv({ RATE_LIMIT_LOGIN_PER_MIN: undefined });
    const m = await import(
      `../../src/server/rate-limit-login.ts?t=${Math.random()}`
    );
    m._reset();
    const make = () =>
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
        body: "{}",
      });
    for (let i = 0; i < 5; i++) {
      const r = await m.rateLimitLogin(make());
      expect(r).toBeNull();
    }
    const denied = await m.rateLimitLogin(make());
    expect(denied!.status).toBe(429);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0].action).toBe("rate_limit_blocked");
    expect(all[0].resource_type).toBe("auth");
    expect(all[0].user_id).toBeNull();
    expect(all[0].ip_hash).not.toBeNull();
  });
});
