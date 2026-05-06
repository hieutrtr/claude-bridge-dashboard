// P4-T01 — privacy hash for email addresses.
//
// The audit log NEVER echoes free-text email — instead it records
// `{ emailHash }` derived as base64url(SHA-256(lowercase(trim(email)) + ":" + salt)).
// The salt comes from `AUDIT_IP_HASH_SALT` (or `JWT_SECRET` as the
// fall-through, mirroring `appendAudit`). The hash is deterministic
// for a given (email, salt) pair so forensic queries can correlate
// `auth.magic-link-request` ↔ `auth.magic-link-consume` rows for the
// same recipient without ever storing the address.
//
// Salt rotation invalidates correlation but never breaks the audit
// log — old rows simply read as opaque hashes against the new salt.

import { createHash } from "node:crypto";

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailHash(email: string, salt: string): string {
  if (salt.length === 0) {
    throw new Error("emailHash: salt must be non-empty");
  }
  const digest = createHash("sha256")
    .update(`${normalizeEmail(email)}:${salt}`)
    .digest();
  return base64UrlEncode(
    new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength),
  );
}

/**
 * Resolve the salt the same way audit.ts does — explicit env var first,
 * then JWT_SECRET, else null. Returning null lets callers downgrade to
 * an opaque sentinel rather than throwing; magic-link request audits
 * still record an "email_hash unavailable" marker when the salt is
 * missing and the dashboard is misconfigured.
 */
export function resolveAuditSalt(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = env.AUDIT_IP_HASH_SALT;
  if (explicit && explicit.length > 0) return explicit;
  const jwt = env.JWT_SECRET;
  return jwt && jwt.length > 0 ? jwt : null;
}
