// P4-T01 — POST /api/auth/magic-link/request route. Asserts:
//   1. Always returns 200 on validated email (privacy: no enumeration).
//   2. Inserts a magic_links row keyed by SHA-256(token).
//   3. Sends email via the injected fake Resend fetch.
//   4. Audits `auth.magic-link-request` with emailHash (NOT plaintext).
//   5. Rate-limits by IP + email-hash (5/min/IP, 5/hour/email).
//   6. Returns 503 when JWT_SECRET is missing.
//   7. Returns 400 on malformed body / missing email.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { POST } from "../../app/api/auth/magic-link/request/route";
import { resetDb, getSqlite } from "../../src/server/db";
import { __resetAudit, __setAuditDb } from "../../src/server/audit";
import { __setResendFetch } from "../../src/server/resend";
import { hashMagicLinkToken } from "../../src/lib/magic-link-token";
import { emailHash } from "../../src/lib/email-hash";

const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let dbPath: string;
let db: Database;
let resendCalls: Array<{ url: string; init?: RequestInit }>;

beforeEach(async () => {
  process.env.JWT_SECRET = "magic-link-test-secret";
  process.env.AUDIT_IP_HASH_SALT = "magic-link-test-salt";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM_EMAIL = "noreply@bridge.local";
  delete process.env.RATE_LIMIT_MAGIC_LINK_IP_PER_MIN;
  delete process.env.RATE_LIMIT_MAGIC_LINK_EMAIL_PER_HOUR;
  tmpDir = mkdtempSync(join(tmpdir(), "magic-link-request-test-"));
  dbPath = join(tmpDir, "bridge.db");
  process.env.BRIDGE_DB = dbPath;
  resetDb();
  db = getSqlite();
  __resetAudit();
  __setAuditDb(db);
  resendCalls = [];
  __setResendFetch((async (url: string, init?: RequestInit) => {
    resendCalls.push({ url, init });
    return new Response(JSON.stringify({ id: "msg_x" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch);
  // Reset the magic-link rate-limit between tests.
  const m = await import("../../src/server/rate-limit-magic-link");
  m._reset();
});

afterEach(() => {
  __setAuditDb(null);
  __resetAudit();
  __setResendFetch(null);
  resetDb();
  rmSync(tmpDir, { recursive: true, force: true });
  for (const k of [
    "JWT_SECRET",
    "AUDIT_IP_HASH_SALT",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
    "BRIDGE_DB",
    "RATE_LIMIT_MAGIC_LINK_IP_PER_MIN",
    "RATE_LIMIT_MAGIC_LINK_EMAIL_PER_HOUR",
    "BRIDGE_DASHBOARD_ORIGIN",
  ] as const) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k]!;
  }
});

function makeReq(body: unknown, xff = "10.0.0.1"): Request {
  return new Request("http://localhost/api/auth/magic-link/request", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": xff,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function auditRows(): Array<{
  action: string;
  resource_type: string;
  payload_json: string | null;
}> {
  return db
    .prepare(
      "SELECT action, resource_type, payload_json FROM audit_log ORDER BY id ASC",
    )
    .all() as Array<{
    action: string;
    resource_type: string;
    payload_json: string | null;
  }>;
}

function magicLinkRows(): Array<{
  token_hash: string;
  email: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}> {
  return db
    .prepare(
      "SELECT token_hash, email, created_at, expires_at, consumed_at FROM magic_links",
    )
    .all() as Array<{
    token_hash: string;
    email: string;
    created_at: number;
    expires_at: number;
    consumed_at: number | null;
  }>;
}

describe("POST /api/auth/magic-link/request — happy path", () => {
  it("returns 200 + inserts a magic_links row + sends email", async () => {
    const res = await POST(makeReq({ email: "alice@example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const rows = magicLinkRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe("alice@example.com");
    expect(rows[0]!.consumed_at).toBeNull();
    expect(rows[0]!.expires_at - rows[0]!.created_at).toBe(15 * 60 * 1000);
    // token_hash is the SHA-256 base64url digest
    expect(rows[0]!.token_hash.length).toBe(43);
    expect(/^[A-Za-z0-9_-]+$/.test(rows[0]!.token_hash)).toBe(true);

    expect(resendCalls.length).toBe(1);
    expect(resendCalls[0]!.url).toBe("https://api.resend.com/emails");
  });

  it("normalises email to lowercase before insert + email", async () => {
    const res = await POST(makeReq({ email: "Alice@EXAMPLE.com" }));
    expect(res.status).toBe(200);
    const rows = magicLinkRows();
    expect(rows[0]!.email).toBe("alice@example.com");
    const sentBody = JSON.parse(resendCalls[0]!.init!.body as string);
    expect(sentBody.to).toEqual(["alice@example.com"]);
  });

  it("audits auth.magic-link-request with emailHash, NEVER plaintext email", async () => {
    await POST(makeReq({ email: "alice@example.com" }));
    const rows = auditRows();
    const requestRow = rows.find((r) => r.action === "auth.magic-link-request");
    expect(requestRow).toBeDefined();
    expect(requestRow!.payload_json).not.toBeNull();
    const payload = JSON.parse(requestRow!.payload_json!);
    expect(typeof payload.emailHash).toBe("string");
    expect(payload.emailHash.length).toBe(43);
    // Must equal the deterministic hash under the configured salt.
    expect(payload.emailHash).toBe(
      emailHash("alice@example.com", process.env.AUDIT_IP_HASH_SALT!),
    );
    // Must not contain the address.
    expect(JSON.stringify(payload).includes("alice")).toBe(false);
    expect(JSON.stringify(payload).includes("example")).toBe(false);
  });

  it("the token in the email URL hashes to the row's token_hash (single-use anchor)", async () => {
    await POST(makeReq({ email: "bob@example.com" }));
    const rows = magicLinkRows();
    expect(rows.length).toBe(1);
    const sentBody = JSON.parse(resendCalls[0]!.init!.body as string);
    const html = sentBody.html as string;
    const m = html.match(/token=([A-Za-z0-9_-]+)/);
    expect(m).not.toBeNull();
    const sentToken = decodeURIComponent(m![1]!);
    expect(hashMagicLinkToken(sentToken)).toBe(rows[0]!.token_hash);
  });

  it("uses BRIDGE_DASHBOARD_ORIGIN when set", async () => {
    process.env.BRIDGE_DASHBOARD_ORIGIN = "https://dash.example.com";
    await POST(makeReq({ email: "alice@example.com" }));
    const sentBody = JSON.parse(resendCalls[0]!.init!.body as string);
    expect((sentBody.html as string)).toContain(
      "https://dash.example.com/api/auth/magic-link/consume?token=",
    );
  });
});

describe("POST /api/auth/magic-link/request — privacy + graceful failure", () => {
  it("still returns 200 when Resend fails (no enumeration)", async () => {
    __setResendFetch((async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch);
    const res = await POST(makeReq({ email: "alice@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const errorRow = auditRows().find(
      (r) => r.action === "auth.magic-link-request.error",
    );
    expect(errorRow).toBeDefined();
    const payload = JSON.parse(errorRow!.payload_json!);
    expect(payload.code).toBe("resend_error");
    expect(payload.status).toBe(500);
  });

  it("still returns 200 when Resend env is unset", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    const res = await POST(makeReq({ email: "alice@example.com" }));
    expect(res.status).toBe(200);
    const errorRow = auditRows().find(
      (r) => r.action === "auth.magic-link-request.error",
    );
    expect(errorRow).toBeDefined();
    const payload = JSON.parse(errorRow!.payload_json!);
    expect(payload.code).toBe("resend_not_configured");
  });
});

describe("POST /api/auth/magic-link/request — input validation", () => {
  it("returns 400 on malformed body", async () => {
    const res = await POST(makeReq({ wrongField: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("returns 400 on non-JSON body", async () => {
    const res = await POST(makeReq("not-json{"));
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid email format", async () => {
    const res = await POST(makeReq({ email: "not-an-email" }));
    expect(res.status).toBe(400);
  });

  it("returns 503 when JWT_SECRET is missing", async () => {
    delete process.env.JWT_SECRET;
    const res = await POST(makeReq({ email: "alice@example.com" }));
    expect(res.status).toBe(503);
  });
});

describe("POST /api/auth/magic-link/request — rate limiting", () => {
  it("blocks the 6th request from the same IP with 429", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await POST(
        makeReq({ email: `alice${i}@example.com` }, "1.2.3.4"),
      );
      expect(r.status).toBe(200);
    }
    const blocked = await POST(
      makeReq({ email: "alice-final@example.com" }, "1.2.3.4"),
    );
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("blocks the 6th request to the same email even from fresh IPs", async () => {
    for (let i = 0; i < 5; i++) {
      await POST(makeReq({ email: "victim@example.com" }, `10.0.0.${i}`));
    }
    const blocked = await POST(
      makeReq({ email: "victim@example.com" }, "9.9.9.9"),
    );
    expect(blocked.status).toBe(429);
  });
});
