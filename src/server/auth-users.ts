// P4-T01 — `users` row helpers shared by the magic-link API routes,
// the auth tRPC router, and (later) the `users` router (T02). The
// abstraction keeps the SQL surface in one place so privacy + soft-
// delete invariants stay consistent across callers.
//
// Concurrency: every write goes through a prepared statement and we
// rely on SQLite's WAL + BEGIN IMMEDIATE provided by `db.ts`. The
// `INSERT OR IGNORE` followed by a `SELECT` is the conventional
// upsert pattern under SQLite's lack of `RETURNING ... ON CONFLICT`.
//
// Privacy: callers MUST NOT log or echo the returned `email` directly
// — `appendAudit` callers always pass `emailHash` instead.

import { Database } from "bun:sqlite";

import { ENV_OWNER_USER_ID } from "@/src/lib/auth";
import { normalizeEmail } from "@/src/lib/email-hash";
import { getSqlite } from "./db";

export interface UserRow {
  id: string;
  email: string;
  role: "owner" | "member";
  displayName: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  revokedAt: number | null;
}

interface RawUserRow {
  id: string;
  email: string;
  role: string;
  display_name: string | null;
  created_at: number;
  last_login_at: number | null;
  revoked_at: number | null;
}

function fromRaw(raw: RawUserRow): UserRow {
  return {
    id: raw.id,
    email: raw.email,
    role: raw.role === "owner" ? "owner" : "member",
    displayName: raw.display_name,
    createdAt: raw.created_at,
    lastLoginAt: raw.last_login_at,
    revokedAt: raw.revoked_at,
  };
}

export function findUserById(id: string, db?: Database): UserRow | null {
  const handle = db ?? getSqlite();
  const row = handle
    .prepare(
      `SELECT id, email, role, display_name, created_at, last_login_at, revoked_at
         FROM users WHERE id = ?`,
    )
    .get(id) as RawUserRow | null;
  return row ? fromRaw(row) : null;
}

export function findUserByEmail(
  email: string,
  db?: Database,
): UserRow | null {
  const handle = db ?? getSqlite();
  const row = handle
    .prepare(
      `SELECT id, email, role, display_name, created_at, last_login_at, revoked_at
         FROM users WHERE email_lower = ?`,
    )
    .get(normalizeEmail(email)) as RawUserRow | null;
  return row ? fromRaw(row) : null;
}

export interface FindOrCreateUserInput {
  email: string;
  /** Used only when creating the row. Existing rows keep their role. */
  defaultRole?: "owner" | "member";
  /** Generator for new ids — default `crypto.randomUUID()`. */
  newId?: () => string;
  db?: Database;
}

/**
 * Find the user matching `email_lower` or insert a new row. Returns
 * the canonical row in either case. Soft-deleted (revoked) users are
 * still returned by lookup — the caller decides whether revocation is
 * a hard 401 or a recoverable invite. The auth flow treats
 * `revoked_at !== null` as a 401 in the consume route.
 */
export function findOrCreateUser(
  input: FindOrCreateUserInput,
): UserRow {
  const handle = input.db ?? getSqlite();
  const existing = findUserByEmail(input.email, handle);
  if (existing) return existing;

  const id = input.newId ? input.newId() : crypto.randomUUID();
  const role = input.defaultRole ?? "member";
  const createdAt = Date.now();
  handle
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, role, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, input.email.trim(), role, createdAt);
  // Re-read so a concurrent insert that won the race still returns
  // the canonical row.
  const row = findUserByEmail(input.email, handle);
  if (!row) {
    throw new Error("findOrCreateUser: insert succeeded but row not found");
  }
  return row;
}

export function recordLogin(id: string, db?: Database, now?: number): void {
  const handle = db ?? getSqlite();
  handle
    .prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`)
    .run(now ?? Date.now(), id);
}

/**
 * Synthetic identity returned for a session whose `sub` matches the
 * literal env-owner sentinel. Lets the rest of the dashboard treat
 * password-login sessions identically to magic-link sessions without
 * forcing a `users` row write on every password login.
 */
export function envOwnerUser(
  env: Record<string, string | undefined> = process.env,
): UserRow {
  return {
    id: ENV_OWNER_USER_ID,
    email: env.OWNER_EMAIL && env.OWNER_EMAIL.length > 0
      ? env.OWNER_EMAIL
      : "owner@local",
    role: "owner",
    displayName: null,
    createdAt: 0,
    lastLoginAt: null,
    revokedAt: null,
  };
}

/**
 * Resolve the user the session points at:
 *   - `sub === "owner"` → synthetic env-owner row (no DB read).
 *   - otherwise → look up `users` by id.
 * Returns `null` for an unknown id OR a revoked row. The auth router
 * treats both as 401.
 */
export function resolveSessionUser(
  sub: string,
  db?: Database,
): UserRow | null {
  if (sub === ENV_OWNER_USER_ID) {
    return envOwnerUser();
  }
  const row = findUserById(sub, db);
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  return row;
}
