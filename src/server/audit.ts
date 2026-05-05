// T04 — appendAudit helper. Synchronous insert into the dashboard-owned
// `audit_log` table. Called by every mutation procedure (T01/T03/T06/T09)
// and by the entry guards (T07 rate-limit-mutations + rate-limit-login,
// T08 csrf-guard) when they reject a request.
//
// Failure-resilience: writes are wrapped in try/catch; an audit-write
// error logs once to stderr and the caller's request continues. We
// never want a dropped audit row to convert a 200 into a 500.
//
// State (DB handle, salt, prepared statement, one-time warn flag) is
// stored on `globalThis` so that — under bun:test and Next.js dev — a
// freshly-imported instance of this module sees the same DB the test
// seam configured. This mirrors the rate-limit-mutations pattern.

import { Database } from "bun:sqlite";

import { getSqlite } from "./db";

const STATE_KEY = "__bridge_audit_state__";

interface State {
  db: Database | null;
  salt: string | null;
  saltResolved: boolean;
  warnedSerialise: boolean;
  warnedWriteFailure: boolean;
}

function readState(): State {
  const g = globalThis as unknown as Record<string, State | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = {
      db: null,
      salt: null,
      saltResolved: false,
      warnedSerialise: false,
      warnedWriteFailure: false,
    };
    g[STATE_KEY] = s;
  }
  return s;
}

function resolveDb(): Database | null {
  const s = readState();
  if (s.db) return s.db;
  try {
    return getSqlite();
  } catch {
    return null;
  }
}

function resolveSalt(): string | null {
  const s = readState();
  if (s.saltResolved) return s.salt;
  const explicit = process.env.AUDIT_IP_HASH_SALT;
  if (explicit && explicit.length > 0) {
    s.salt = explicit;
  } else {
    const jwt = process.env.JWT_SECRET;
    s.salt = jwt && jwt.length > 0 ? jwt : null;
  }
  s.saltResolved = true;
  return s.salt;
}

function clientIpFromReq(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) {
    const trimmed = real.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// Synchronous SHA-256: Web Crypto's `crypto.subtle.digest` is async.
// To keep `appendAudit` synchronous (matches the bun:sqlite contract
// callers expect — the rate-limit / csrf guards return a Response
// without awaiting an audit promise) we use Node's `crypto` module,
// which is available in both Bun and Node runtimes.
import { createHash } from "node:crypto";

function ipHashSync(ip: string, salt: string): string {
  const buf = createHash("sha256").update(`${ip}:${salt}`).digest();
  return base64UrlEncode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

const REDACT_KEYS = new Set(["password"]);

function sanitisePayload(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let working: unknown = value;
  if (typeof value === "object" && !Array.isArray(value)) {
    const cloned: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const k of Object.keys(cloned)) {
      if (REDACT_KEYS.has(k)) cloned[k] = "<redacted>";
    }
    working = cloned;
  }
  try {
    return JSON.stringify(working);
  } catch (err) {
    const s = readState();
    if (!s.warnedSerialise) {
      // eslint-disable-next-line no-console
      console.warn("audit: payload serialise failed; recording null", err);
      s.warnedSerialise = true;
    }
    return null;
  }
}

function genRequestId(): string {
  // crypto.randomUUID is available in Bun and Node 19+.
  // The runtime guarantee matches the rest of this codebase
  // (csrf token, session JWT) which also rely on Web Crypto.
  return crypto.randomUUID();
}

export interface AppendAuditInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  userId?: string | null;
  payload?: unknown;
  /** Used to derive ip_hash + user_agent + request_id when present. */
  req?: Request;
  /** Overrides the generated/derived request id. */
  requestId?: string;
}

export interface AppendAuditResult {
  id: number;
  requestId: string;
}

export function appendAudit(input: AppendAuditInput): AppendAuditResult {
  const requestId = input.requestId ?? genRequestId();
  const db = resolveDb();
  if (!db) {
    return { id: -1, requestId };
  }

  let ipHash: string | null = null;
  let userAgent: string | null = null;
  if (input.req) {
    const ip = clientIpFromReq(input.req);
    if (ip) {
      const salt = resolveSalt();
      if (salt !== null) ipHash = ipHashSync(ip, salt);
    }
    const ua = input.req.headers.get("user-agent");
    if (ua) userAgent = ua.length > 256 ? ua.slice(0, 256) : ua;
  }

  const payloadJson = sanitisePayload(input.payload);
  const createdAt = Date.now();

  try {
    const stmt = db.prepare(
      `INSERT INTO audit_log
        (user_id, action, resource_type, resource_id, payload_json, ip_hash, user_agent, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    );
    const row = stmt.get(
      input.userId ?? null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      payloadJson,
      ipHash,
      userAgent,
      requestId,
      createdAt,
    ) as { id: number } | null;
    return { id: row?.id ?? -1, requestId };
  } catch (err) {
    const s = readState();
    if (!s.warnedWriteFailure) {
      // eslint-disable-next-line no-console
      console.error("audit: write failed; subsequent failures suppressed", err);
      s.warnedWriteFailure = true;
    }
    return { id: -1, requestId };
  }
}

// Test seam — inject a specific Database (or `null` to clear). When
// non-null, `resolveDb()` returns this DB instead of going through
// `getSqlite()`. Lives on globalThis so module reloads see the same DB.
export function __setAuditDb(db: Database | null): void {
  readState().db = db;
}

// Test seam — reset cached salt + warn flags so each test starts clean.
export function __resetAudit(): void {
  const s = readState();
  s.salt = null;
  s.saltResolved = false;
  s.warnedSerialise = false;
  s.warnedWriteFailure = false;
}
