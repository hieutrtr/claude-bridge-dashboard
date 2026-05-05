// CSRF — signed double-submit cookie. See docs/adr/0001-csrf-strategy.md.
//
// Token format: `<base64url(random16)>.<base64url(hmac-sha256(random16, secret))>`.
// Verification: split, recompute HMAC, constant-time compare with the supplied
// signature. The same string lives in the `bridge_csrf_token` cookie and the
// `x-csrf-token` request header on every state-changing call; the server-side
// guard byte-equals the two and then verifies the signature.

import { timingSafeEqual } from "./auth";

export const CSRF_COOKIE = "bridge_csrf_token";
export const CSRF_HEADER = "x-csrf-token";

const ENCODER = new TextEncoder();
const RANDOM_BYTES = 16;

export async function issueCsrfToken(secret: string): Promise<string> {
  if (!secret) throw new Error("csrf: secret is required to issue a token");
  const random = new Uint8Array(RANDOM_BYTES);
  crypto.getRandomValues(random);
  const randomB64 = base64UrlEncode(random);
  const sig = await hmacSign(randomB64, secret);
  return `${randomB64}.${sig}`;
}

export async function verifyCsrfToken(token: string, secret: string): Promise<boolean> {
  if (!secret) throw new Error("csrf: secret is required to verify a token");
  if (typeof token !== "string" || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [randomB64, sigB64] = parts;
  if (!randomB64 || !sigB64) return false;
  if (!isBase64Url(randomB64) || !isBase64Url(sigB64)) return false;
  const expected = await hmacSign(randomB64, secret);
  return timingSafeEqual(sigB64, expected);
}

async function hmacSign(input: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, ENCODER.encode(input));
  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isBase64Url(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s);
}
