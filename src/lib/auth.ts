export const SESSION_COOKIE = "bridge_dashboard_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const HEADER_B64 = base64UrlEncode(ENCODER.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

// P4-T01 — `sub` widened from literal `"owner"` to any non-empty string
// so magic-link sessions can carry the `users.id` UUID. Existing
// password-login sessions continue to sign `sub: "owner"` (P1 default)
// and stay valid; the dashboard treats a literal `"owner"` as the
// synthetic env-owner identity (see `src/server/routers/auth.ts`).
export interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface AuthEnv {
  password: string | null;
  secret: string | null;
}

export interface SignSessionOptions {
  /** Subject claim. Defaults to `"owner"` for backwards-compat with P1 password sessions. */
  sub?: string;
  /** Override `iat` (epoch seconds). Used by tests to drive deterministic tokens. */
  now?: number;
}

export async function signSession(
  secret: string,
  opts?: SignSessionOptions,
): Promise<string> {
  if (!secret) throw new Error("auth: secret is required to sign a session");
  const sub = opts?.sub ?? "owner";
  if (sub.length === 0) {
    throw new Error("auth: sub must be a non-empty string");
  }
  const iat = opts?.now ?? Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub,
    iat,
    exp: iat + SESSION_TTL_SECONDS,
  };
  const payloadB64 = base64UrlEncode(ENCODER.encode(JSON.stringify(payload)));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sigB64 = await hmacSign(signingInput, secret);
  return `${signingInput}.${sigB64}`;
}

export async function verifySession(
  token: string,
  secret: string,
  now?: number,
): Promise<SessionPayload | null> {
  if (!secret) throw new Error("auth: secret is required to verify a session");
  if (typeof token !== "string" || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) return null;
  const expected = await hmacSign(`${headerB64}.${payloadB64}`, secret);
  if (!timingSafeEqual(sigB64, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(DECODER.decode(base64UrlDecode(payloadB64)));
  } catch {
    return null;
  }
  if (!isSessionPayload(payload)) return null;
  const current = now ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= current) return null;
  return payload;
}

/** Stable id for the env-password ("password") owner, when no `users` row exists yet. */
export const ENV_OWNER_USER_ID = "owner";

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function readAuthEnv(env: Record<string, string | undefined> = process.env): AuthEnv {
  const password = env.DASHBOARD_PASSWORD;
  const secret = env.JWT_SECRET;
  return {
    password: password && password.length > 0 ? password : null,
    secret: secret && secret.length > 0 ? secret : null,
  };
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sub === "string" &&
    v.sub.length > 0 &&
    typeof v.iat === "number" &&
    typeof v.exp === "number" &&
    Number.isFinite(v.iat) &&
    Number.isFinite(v.exp)
  );
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

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLen));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
