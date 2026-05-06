// P4-T01 — magic-link token primitives.
//
// `generateMagicLinkToken()` produces a 32-byte URL-safe random token
// suitable for embedding in a one-shot login URL. `hashMagicLinkToken`
// returns the SHA-256 base64url digest used as the `magic_links`
// PRIMARY KEY — the plaintext token is emailed and held only by the
// recipient; the database stores only the hash so a DB read does not
// permit attackers to consume outstanding tokens.
//
// We use `node:crypto` (available in Bun + Node) so the helper is
// synchronous and matches the audit module's hashing pattern.

import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function generateMagicLinkToken(): string {
  return base64UrlEncode(new Uint8Array(randomBytes(TOKEN_BYTES)));
}

export function hashMagicLinkToken(token: string): string {
  const digest = createHash("sha256").update(token).digest();
  return base64UrlEncode(
    new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength),
  );
}

/** 15 minutes (per v1 ARCHITECTURE §6 — "≤ 15 min token TTL"). */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

/** A token shape that obviously isn't a real one — used in tests as a sentinel. */
export const MAGIC_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
