// P4-T01 — GET /api/auth/magic-link/consume?token=...
//
// One-shot login endpoint embedded in the email body. Steps:
//   1. Per-IP rate limit (5/min/IP) — bounds attacker grind on guessed
//      or stolen tokens. (Tokens are 32 random bytes so brute force is
//      infeasible; the bucket is belt-and-braces against side channels.)
//   2. SHA-256(token) lookup against `magic_links` and atomically
//      `UPDATE … SET consumed_at WHERE consumed_at IS NULL` so a
//      simultaneous click in two tabs yields exactly one consumer.
//   3. `expires_at` check (15 min default per `MAGIC_LINK_TTL_SECONDS`).
//   4. Find-or-create the matching `users` row.
//   5. Sign a session JWT with `sub: user.id` and set the HttpOnly
//      cookie + the CSRF cookie (matches `/api/auth/login` shape).
//   6. Redirect to `/agents` (or the next-param redirect target).
//
// Failure modes redirect back to `/login?error=…` so the user lands
// somewhere actionable. Audit log records every outcome with the
// `tokenIdPrefix: hash.slice(0,8)` privacy sentinel — the full token
// hash is never logged.

import { NextResponse } from "next/server";

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  readAuthEnv,
  signSession,
} from "@/src/lib/auth";
import { CSRF_COOKIE, issueCsrfToken } from "@/src/lib/csrf";
import {
  emailHash as makeEmailHash,
  resolveAuditSalt,
} from "@/src/lib/email-hash";
import { hashMagicLinkToken } from "@/src/lib/magic-link-token";
import { appendAudit } from "@/src/server/audit";
import { rateLimitMagicLinkConsume } from "@/src/server/rate-limit-magic-link";
import { getSqlite } from "@/src/server/db";
import { findOrCreateUser, recordLogin } from "@/src/server/auth-users";

interface MagicLinkRow {
  email: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

function loginRedirect(req: Request, error: string, next?: string): Response {
  const url = new URL(req.url);
  const target = new URL(`/login`, `${url.protocol}//${url.host}`);
  target.searchParams.set("error", error);
  if (next && next.startsWith("/")) target.searchParams.set("next", next);
  return NextResponse.redirect(target);
}

function safeNext(raw: string | null): string {
  if (!raw) return "/agents";
  if (!raw.startsWith("/")) return "/agents";
  if (raw.startsWith("//")) return "/agents";
  return raw;
}

export async function GET(req: Request): Promise<Response> {
  // Rate-limit FIRST so a flood of bad tokens spends the bucket and
  // can't be used as an oracle.
  const blocked = rateLimitMagicLinkConsume(req);
  if (blocked) return blocked;

  const { secret } = readAuthEnv();
  if (!secret) {
    return NextResponse.json(
      { error: "auth_not_configured" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const next = safeNext(url.searchParams.get("next"));
  if (!token || token.length === 0) {
    appendAudit({
      action: "auth.magic-link-consume.error",
      resourceType: "auth",
      payload: { code: "missing_token" },
      req,
    });
    return loginRedirect(req, "missing_token", next);
  }

  const tokenHash = hashMagicLinkToken(token);
  const tokenIdPrefix = tokenHash.slice(0, 8);
  const auditBase = {
    resourceType: "auth" as const,
    req,
  };

  let db;
  try {
    db = getSqlite();
  } catch (err) {
    appendAudit({
      ...auditBase,
      action: "auth.magic-link-consume.error",
      payload: {
        tokenIdPrefix,
        code: "db_unavailable",
        message: err instanceof Error ? err.message.slice(0, 256) : "unknown",
      },
    });
    return loginRedirect(req, "server_error", next);
  }

  // Atomic single-use guard: the UPDATE only affects the row when
  // `consumed_at IS NULL`. We then SELECT the row to read the email +
  // expiry; if the SELECT shows `consumed_at` !== `now` it means our
  // UPDATE was a no-op (race lost or token already used).
  const now = Date.now();
  const update = db
    .prepare(
      `UPDATE magic_links
          SET consumed_at = ?
        WHERE token_hash = ?
          AND consumed_at IS NULL`,
    )
    .run(now, tokenHash);

  // `bun:sqlite` returns `{ changes, lastInsertRowid }` from .run().
  const changes = (update as { changes?: number }).changes ?? 0;

  const row = db
    .prepare(
      `SELECT email, created_at, expires_at, consumed_at
         FROM magic_links WHERE token_hash = ?`,
    )
    .get(tokenHash) as MagicLinkRow | null;

  if (!row) {
    // Unknown token → 410 Gone semantically; we redirect with the
    // "invalid_token" code so the login page can show a helpful copy.
    appendAudit({
      ...auditBase,
      action: "auth.magic-link-consume.error",
      payload: { tokenIdPrefix, code: "invalid_token" },
    });
    return loginRedirect(req, "invalid_token", next);
  }

  if (changes === 0) {
    // The token existed but our UPDATE didn't change anything — i.e.
    // it was already consumed or expired-and-then-consumed-by-cleanup.
    appendAudit({
      ...auditBase,
      action: "auth.magic-link-consume",
      payload: {
        tokenIdPrefix,
        status: "already_used",
      },
    });
    return loginRedirect(req, "used_token", next);
  }

  if (row.expires_at <= now) {
    // We did consume the row, but it was expired. The audit row keeps
    // a clean trail. (The row stays consumed so a second click also
    // 410s rather than re-running the lookup.)
    appendAudit({
      ...auditBase,
      action: "auth.magic-link-consume.error",
      payload: { tokenIdPrefix, code: "expired" },
    });
    return loginRedirect(req, "expired_token", next);
  }

  // Find or create the user. New rows default to role:`member`.
  let user;
  try {
    user = findOrCreateUser({ email: row.email, db });
  } catch (err) {
    appendAudit({
      ...auditBase,
      action: "auth.magic-link-consume.error",
      payload: {
        tokenIdPrefix,
        code: "user_upsert_failed",
        message: err instanceof Error ? err.message.slice(0, 256) : "unknown",
      },
    });
    return loginRedirect(req, "server_error", next);
  }

  if (user.revokedAt !== null) {
    appendAudit({
      ...auditBase,
      action: "auth.magic-link-consume.error",
      userId: user.id,
      payload: { tokenIdPrefix, code: "revoked" },
    });
    return loginRedirect(req, "user_revoked", next);
  }

  recordLogin(user.id, db, now);

  const salt = resolveAuditSalt();
  const recordEmailHash = salt ? makeEmailHash(row.email, salt) : null;
  appendAudit({
    ...auditBase,
    action: "auth.magic-link-consume",
    userId: user.id,
    payload: {
      tokenIdPrefix,
      status: "ok",
      ...(recordEmailHash ? { emailHash: recordEmailHash } : {}),
    },
  });

  const [sessionToken, csrfToken] = await Promise.all([
    signSession(secret, { sub: user.id }),
    issueCsrfToken(secret),
  ]);
  const isProd = process.env.NODE_ENV === "production";
  const target = new URL(next, `${url.protocol}//${url.host}`);
  const res = NextResponse.redirect(target);
  res.cookies.set({
    name: SESSION_COOKIE,
    value: sessionToken,
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  res.cookies.set({
    name: CSRF_COOKIE,
    value: csrfToken,
    httpOnly: false,
    sameSite: "lax",
    secure: isProd,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
