// P4-T01 — GET /api/auth/magic-link/consume route. Asserts:
//   1. Valid token → 307/302 redirect to /agents (or `next` param), sets
//      session + CSRF cookies, audits `auth.magic-link-consume`.
//   2. Second use of the same token → redirect to /login?error=used_token,
//      audits `auth.magic-link-consume status:already_used`.
//   3. Expired token → redirect to /login?error=expired_token.
//   4. Unknown token → redirect to /login?error=invalid_token.
//   5. Missing token → 302 with error=missing_token.
//   6. Token never plaintext-logged (only tokenIdPrefix in payload).
//   7. Find-or-create user — first consume creates a `users` row;
//      second create reuses it.
//   8. Revoked user → redirect with error=user_revoked, no cookie.
//   9. Rate-limit (5/min/IP) on consume failures.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET } from "../../app/api/auth/magic-link/consume/route";
import {
  SESSION_COOKIE,
  verifySession,
} from "../../src/lib/auth";
import { CSRF_COOKIE } from "../../src/lib/csrf";
import {
  hashMagicLinkToken,
  MAGIC_LINK_TTL_SECONDS,
} from "../../src/lib/magic-link-token";
import { resetDb, getSqlite } from "../../src/server/db";
import { __resetAudit, __setAuditDb } from "../../src/server/audit";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "magic-consume-test-secret";

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(async () => {
  process.env.JWT_SECRET = SECRET;
  process.env.AUDIT_IP_HASH_SALT = "consume-salt";
  delete process.env.RATE_LIMIT_MAGIC_LINK_CONSUME_PER_MIN;
  tmpDir = mkdtempSync(join(tmpdir(), "magic-link-consume-test-"));
  dbPath = join(tmpDir, "bridge.db");
  process.env.BRIDGE_DB = dbPath;
  resetDb();
  db = getSqlite();
  __resetAudit();
  __setAuditDb(db);
  const m = await import("../../src/server/rate-limit-magic-link");
  m._reset();
});

afterEach(() => {
  __setAuditDb(null);
  __resetAudit();
  resetDb();
  rmSync(tmpDir, { recursive: true, force: true });
  for (const k of [
    "JWT_SECRET",
    "AUDIT_IP_HASH_SALT",
    "BRIDGE_DB",
    "RATE_LIMIT_MAGIC_LINK_CONSUME_PER_MIN",
  ] as const) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k]!;
  }
});

interface SeedTokenInput {
  email: string;
  expiresAtMs?: number;
  consumedAtMs?: number | null;
}

function seedToken(opts: SeedTokenInput): { token: string; tokenHash: string } {
  // Use a deterministic-looking token; the hash is what matters.
  const token = `test-token-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const tokenHash = hashMagicLinkToken(token);
  const now = Date.now();
  const expiresAt = opts.expiresAtMs ?? now + MAGIC_LINK_TTL_SECONDS * 1000;
  db.prepare(
    `INSERT INTO magic_links (token_hash, email, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tokenHash, opts.email, now, expiresAt, opts.consumedAtMs ?? null);
  return { token, tokenHash };
}

function makeReq(token: string, opts?: { next?: string; xff?: string }): Request {
  const params = new URLSearchParams({ token });
  if (opts?.next) params.set("next", opts.next);
  return new Request(
    `http://localhost/api/auth/magic-link/consume?${params.toString()}`,
    {
      method: "GET",
      headers: opts?.xff ? { "x-forwarded-for": opts.xff } : {},
    },
  );
}

function parseSetCookie(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of res.headers.getSetCookie()) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function auditRows(): Array<{
  action: string;
  user_id: string | null;
  payload_json: string | null;
}> {
  return db
    .prepare(
      "SELECT action, user_id, payload_json FROM audit_log ORDER BY id ASC",
    )
    .all() as Array<{
    action: string;
    user_id: string | null;
    payload_json: string | null;
  }>;
}

describe("GET /api/auth/magic-link/consume — happy path", () => {
  it("valid token → 302/307 to /agents, sets session + CSRF cookies", async () => {
    const { token, tokenHash } = seedToken({ email: "alice@example.com" });
    const res = await GET(makeReq(token));
    expect([302, 307]).toContain(res.status);
    expect(res.headers.get("location")).toContain("/agents");
    const cookies = parseSetCookie(res);
    expect(cookies[SESSION_COOKIE]).toBeDefined();
    expect(cookies[SESSION_COOKIE]!.length).toBeGreaterThan(0);
    expect(cookies[CSRF_COOKIE]).toBeDefined();

    // Session sub matches the upserted user id (UUID), not "owner".
    const payload = await verifySession(cookies[SESSION_COOKIE]!, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).not.toBe("owner");
    expect(payload!.sub.length).toBeGreaterThan(0);

    // magic_links.consumed_at is now non-null
    const row = db
      .prepare(
        `SELECT consumed_at FROM magic_links WHERE token_hash = ?`,
      )
      .get(tokenHash) as { consumed_at: number | null };
    expect(row.consumed_at).not.toBeNull();

    // users row exists for the email
    const userRow = db
      .prepare(`SELECT id, email, role FROM users WHERE email = ?`)
      .get("alice@example.com") as { id: string; email: string; role: string };
    expect(userRow).toBeDefined();
    expect(userRow.id).toBe(payload!.sub);
    expect(userRow.role).toBe("member");
  });

  it("audits auth.magic-link-consume with tokenIdPrefix only, NEVER full token", async () => {
    const { token, tokenHash } = seedToken({ email: "alice@example.com" });
    await GET(makeReq(token));
    const row = auditRows().find((r) => r.action === "auth.magic-link-consume");
    expect(row).toBeDefined();
    expect(row!.user_id).not.toBeNull();
    const payload = JSON.parse(row!.payload_json!);
    expect(payload.status).toBe("ok");
    expect(payload.tokenIdPrefix).toBe(tokenHash.slice(0, 8));
    // Plaintext token must NEVER appear anywhere in the audit row.
    const blob = JSON.stringify(row);
    expect(blob.includes(token)).toBe(false);
  });

  it("respects safe `next` query param", async () => {
    const { token } = seedToken({ email: "alice@example.com" });
    const res = await GET(makeReq(token, { next: "/cost" }));
    expect(res.headers.get("location")).toContain("/cost");
  });

  it("rejects unsafe `next` (open-redirect) and falls back to /agents", async () => {
    const { token } = seedToken({ email: "alice@example.com" });
    const res = await GET(makeReq(token, { next: "//evil.example.com" }));
    expect(res.headers.get("location")).toContain("/agents");
    expect(res.headers.get("location")).not.toContain("evil.example.com");
  });

  it("subsequent consume of same token → /login?error=used_token", async () => {
    const { token } = seedToken({ email: "alice@example.com" });
    await GET(makeReq(token));
    const res = await GET(makeReq(token));
    expect([302, 307]).toContain(res.status);
    expect(res.headers.get("location")).toContain("/login?error=used_token");
    // No new session cookie issued on the second attempt.
    const cookies = parseSetCookie(res);
    expect(cookies[SESSION_COOKIE]).toBeUndefined();

    const row = auditRows().find(
      (r) =>
        r.action === "auth.magic-link-consume" &&
        r.payload_json !== null &&
        JSON.parse(r.payload_json!).status === "already_used",
    );
    expect(row).toBeDefined();
  });

  it("re-uses an existing users row (no duplicate insert)", async () => {
    const { token: token1 } = seedToken({ email: "alice@example.com" });
    await GET(makeReq(token1));
    const { token: token2 } = seedToken({ email: "alice@example.com" });
    await GET(makeReq(token2));
    const userCount = (
      db
        .prepare("SELECT COUNT(*) as n FROM users WHERE email = ?")
        .get("alice@example.com") as { n: number }
    ).n;
    expect(userCount).toBe(1);
  });
});

describe("GET /api/auth/magic-link/consume — failure paths", () => {
  it("expired token → /login?error=expired_token (no cookie)", async () => {
    const { token } = seedToken({
      email: "alice@example.com",
      expiresAtMs: Date.now() - 1,
    });
    const res = await GET(makeReq(token));
    expect(res.headers.get("location")).toContain("/login?error=expired_token");
    expect(parseSetCookie(res)[SESSION_COOKIE]).toBeUndefined();
  });

  it("unknown token → /login?error=invalid_token", async () => {
    const res = await GET(makeReq("never-issued-token-xyz"));
    expect(res.headers.get("location")).toContain("/login?error=invalid_token");
  });

  it("missing token → /login?error=missing_token", async () => {
    const req = new Request(
      `http://localhost/api/auth/magic-link/consume`,
      { method: "GET" },
    );
    const res = await GET(req);
    expect(res.headers.get("location")).toContain("/login?error=missing_token");
  });

  it("revoked user → /login?error=user_revoked, no cookie", async () => {
    const { token } = seedToken({ email: "ex@example.com" });
    db.prepare(
      `INSERT INTO users (id, email, role, created_at, revoked_at)
       VALUES ('uuid-rv', 'ex@example.com', 'member', ?, ?)`,
    ).run(Date.now() - 1000, Date.now());
    const res = await GET(makeReq(token));
    expect(res.headers.get("location")).toContain("/login?error=user_revoked");
    expect(parseSetCookie(res)[SESSION_COOKIE]).toBeUndefined();
  });
});

describe("GET /api/auth/magic-link/consume — rate limit", () => {
  it("blocks the 6th attempt from the same IP with 429 (token grinding defence)", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await GET(makeReq(`bad-${i}`, { xff: "1.2.3.4" }));
      // Bad tokens redirect to /login?error=invalid_token, not 200, but
      // the rate-limit guard runs FIRST so they all spend tokens.
      expect(r.status).not.toBe(429);
    }
    const r6 = await GET(makeReq("bad-6", { xff: "1.2.3.4" }));
    expect(r6.status).toBe(429);
  });
});
