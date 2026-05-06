// P4-T01 — POST /api/auth/magic-link/request
//
// Public unauthenticated endpoint. Accepts `{ email }`, runs the
// magic-link rate-limit (5/min/IP + 5/hour/email_hash), creates a
// `magic_links` row, sends the email via Resend, and ALWAYS returns
// 200 — the response body never reveals whether the email matches an
// existing user (privacy + anti-enumeration). Configuration failures
// (missing RESEND_API_KEY, missing JWT_SECRET) and network errors
// are logged via the audit trail but the user-visible response is
// the same `{ ok: true }` as a successful send.
//
// CSRF: this route is exempt from the global CSRF guard for the same
// reason `/api/auth/login` is — there's no session cookie on the
// pre-login page yet, so there's no CSRF cookie to compare. The
// rate-limit guard (5/min/IP) covers the brute-force window.

import { NextResponse } from "next/server";
import { z } from "zod";

import { readAuthEnv } from "@/src/lib/auth";
import {
  emailHash as makeEmailHash,
  resolveAuditSalt,
  normalizeEmail,
} from "@/src/lib/email-hash";
import {
  generateMagicLinkToken,
  hashMagicLinkToken,
  MAGIC_LINK_TTL_SECONDS,
} from "@/src/lib/magic-link-token";
import { appendAudit } from "@/src/server/audit";
import { rateLimitMagicLinkRequest } from "@/src/server/rate-limit-magic-link";
import { sendMagicLinkEmail } from "@/src/server/resend";
import { getSqlite } from "@/src/server/db";

const Body = z.object({
  email: z.string().min(3).max(320).email(),
});

const SUCCESS = { ok: true as const };

function clientIp(req: Request): string | null {
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

function ipHashFromReq(req: Request, salt: string): string | null {
  const ip = clientIp(req);
  if (!ip) return null;
  return makeEmailHash(`ip:${ip}`, salt);
}

function consumeUrlBase(req: Request): string {
  const env = process.env.BRIDGE_DASHBOARD_ORIGIN;
  if (env && env.length > 0) return env.replace(/\/+$/, "");
  // Fall back to the request origin so the email link points back
  // to the same host the request came from.
  try {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "http://127.0.0.1:7878";
  }
}

export async function POST(req: Request): Promise<Response> {
  const { secret } = readAuthEnv();
  if (!secret) {
    // Without JWT_SECRET the consume route cannot mint a session, so
    // the dashboard is unconfigured — refuse politely.
    return NextResponse.json(
      { error: "auth_not_configured" },
      { status: 503 },
    );
  }

  let json: unknown = null;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const email = normalizeEmail(parsed.data.email);
  const salt = resolveAuditSalt();
  // Without an audit salt we cannot compute the email-hash bucket key
  // — fall back to a bucket-killing constant so the per-IP bucket is
  // the only line of defence. The audit row records the misconfig.
  const hashedEmail = salt ? makeEmailHash(email, salt) : "no-salt";

  const blocked = rateLimitMagicLinkRequest({ req, emailHash: hashedEmail });
  if (blocked) return blocked;

  // Audit the request BEFORE the email send — we want a row even if
  // Resend is down. Privacy: only `emailHash` is recorded.
  appendAudit({
    action: "auth.magic-link-request",
    resourceType: "auth",
    payload: { emailHash: hashedEmail },
    req,
  });

  const token = generateMagicLinkToken();
  const tokenHash = hashMagicLinkToken(token);
  const now = Date.now();
  const expiresAt = now + MAGIC_LINK_TTL_SECONDS * 1000;

  try {
    const db = getSqlite();
    const ipHash = salt ? ipHashFromReq(req, salt) : null;
    db.prepare(
      `INSERT INTO magic_links
         (token_hash, email, created_at, expires_at, request_ip_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(tokenHash, email, now, expiresAt, ipHash);
  } catch (err) {
    // Database unreachable. Audit the failure (no email leaked) but
    // still return 200 to avoid an enumeration oracle.
    appendAudit({
      action: "auth.magic-link-request.error",
      resourceType: "auth",
      payload: {
        emailHash: hashedEmail,
        code: "db_insert_failed",
        message: err instanceof Error ? err.message.slice(0, 256) : "unknown",
      },
      req,
    });
    return NextResponse.json(SUCCESS);
  }

  const consumeUrl = `${consumeUrlBase(req)}/api/auth/magic-link/consume?token=${encodeURIComponent(token)}`;
  const expiresIso = new Date(expiresAt).toISOString();
  const send = await sendMagicLinkEmail({
    to: email,
    consumeUrl,
    expiresAtIso: expiresIso,
  });
  if (!send.ok) {
    appendAudit({
      action: "auth.magic-link-request.error",
      resourceType: "auth",
      payload: {
        emailHash: hashedEmail,
        code: send.reason,
        ...(send.reason === "resend_error" && send.status !== undefined
          ? { status: send.status }
          : {}),
      },
      req,
    });
    // Privacy: still return 200 — the response shape must not leak
    // which emails the dashboard is configured to send to. The user
    // never sees a magic-link email; the audit log captures the gap.
  }
  return NextResponse.json(SUCCESS);
}
