// P4-T01 — rate-limit guard for magic-link request emissions.
//
// Two separate buckets sized per v1 ARCH §10 (brute-force mitigation):
//
//   1. 5 requests / minute / IP — bounds local burst rate. Same shape
//      as `rate-limit-login.ts`, separate bucket so login attempts and
//      magic-link requests don't compete for the same tokens.
//   2. 5 requests / hour / email_hash — bounds the recipient's inbox,
//      which is the abuse vector users actually feel. The bucket is
//      keyed by the SHA-256(email + salt) so we never store plaintext
//      addresses for anti-abuse purposes.
//
// Both buckets must permit the request for it to proceed. Either
// denial yields a 429 with `Retry-After`; the audit row records which
// scope (`ip` or `email`) tripped, never the email itself.
//
// `rateLimitMagicLinkConsume` is a single 5/min/IP bucket reused for
// failed consume attempts so an attacker can't grind through stolen
// or guessed tokens at unbounded rate.

import {
  _resetBuckets,
  consume,
  createBucket,
  type Bucket,
} from "@/src/lib/rate-limit";
import { appendAudit } from "@/src/server/audit";

const DEFAULT_REQUEST_PER_MIN_IP = 5;
const DEFAULT_REQUEST_PER_HOUR_EMAIL = 5;
const DEFAULT_CONSUME_PER_MIN_IP = 5;

const STATE_KEY = "__bridge_rate_limit_magic_link__";

interface State {
  ipBucket: Bucket;
  emailBucket: Bucket;
  consumeBucket: Bucket;
  ipCapacity: number;
  emailCapacity: number;
  consumeCapacity: number;
}

function readCapacity(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function getState(): State {
  const g = globalThis as unknown as Record<string, State | undefined>;
  const ipCapacity = readCapacity(
    "RATE_LIMIT_MAGIC_LINK_IP_PER_MIN",
    DEFAULT_REQUEST_PER_MIN_IP,
  );
  const emailCapacity = readCapacity(
    "RATE_LIMIT_MAGIC_LINK_EMAIL_PER_HOUR",
    DEFAULT_REQUEST_PER_HOUR_EMAIL,
  );
  const consumeCapacity = readCapacity(
    "RATE_LIMIT_MAGIC_LINK_CONSUME_PER_MIN",
    DEFAULT_CONSUME_PER_MIN_IP,
  );
  const cached = g[STATE_KEY];
  if (
    cached &&
    cached.ipCapacity === ipCapacity &&
    cached.emailCapacity === emailCapacity &&
    cached.consumeCapacity === consumeCapacity
  ) {
    return cached;
  }
  const fresh: State = {
    ipCapacity,
    emailCapacity,
    consumeCapacity,
    ipBucket: createBucket({
      capacity: ipCapacity,
      refillPerSec: ipCapacity / 60,
    }),
    emailBucket: createBucket({
      capacity: emailCapacity,
      refillPerSec: emailCapacity / 3600,
    }),
    consumeBucket: createBucket({
      capacity: consumeCapacity,
      refillPerSec: consumeCapacity / 60,
    }),
  };
  g[STATE_KEY] = fresh;
  return fresh;
}

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

export interface MagicLinkRequestRateLimitInput {
  /** Original Request — used to derive the client IP and audit metadata. */
  req: Request;
  /** SHA-256 hash of the recipient email. Never the plaintext. */
  emailHash: string;
}

/**
 * Returns a 429 Response when EITHER the per-IP or per-email bucket
 * is exhausted. Returns `null` when the request may proceed. Audits
 * blocked requests with `scope: "ip" | "email"` and the retry-after.
 *
 * IMPORTANT: a successful return CONSUMES tokens from BOTH buckets.
 * Callers must not invoke this guard speculatively.
 */
export function rateLimitMagicLinkRequest(
  input: MagicLinkRequestRateLimitInput,
): Response | null {
  const state = getState();
  const ip = clientIp(input.req) ?? "unknown";

  if (state.ipCapacity > 0) {
    const ipResult = consume(state.ipBucket, ip);
    if (!ipResult.ok) {
      appendAudit({
        action: "rate_limit_blocked",
        resourceType: "auth",
        payload: {
          retryAfterSec: ipResult.retryAfterSec,
          scope: "magic-link-request:ip",
        },
        req: input.req,
      });
      return new Response(
        JSON.stringify({
          error: "rate_limited",
          retryAfterSec: ipResult.retryAfterSec,
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "Retry-After": String(ipResult.retryAfterSec),
          },
        },
      );
    }
  }

  if (state.emailCapacity > 0) {
    const emailResult = consume(state.emailBucket, input.emailHash);
    if (!emailResult.ok) {
      appendAudit({
        action: "rate_limit_blocked",
        resourceType: "auth",
        payload: {
          retryAfterSec: emailResult.retryAfterSec,
          scope: "magic-link-request:email",
          emailHash: input.emailHash,
        },
        req: input.req,
      });
      return new Response(
        JSON.stringify({
          error: "rate_limited",
          retryAfterSec: emailResult.retryAfterSec,
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "Retry-After": String(emailResult.retryAfterSec),
          },
        },
      );
    }
  }

  return null;
}

/**
 * Per-IP rate limit for failed consume attempts. Returns a 429
 * Response when exhausted, else `null`. Token usage is the caller's
 * responsibility — this guard only consumes when invoked, so the
 * caller may decide to skip the consume on success.
 */
export function rateLimitMagicLinkConsume(req: Request): Response | null {
  const state = getState();
  if (state.consumeCapacity === 0) return null;
  const ip = clientIp(req) ?? "unknown";
  const result = consume(state.consumeBucket, ip);
  if (result.ok) return null;
  appendAudit({
    action: "rate_limit_blocked",
    resourceType: "auth",
    payload: {
      retryAfterSec: result.retryAfterSec,
      scope: "magic-link-consume:ip",
    },
    req,
  });
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      retryAfterSec: result.retryAfterSec,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "Retry-After": String(result.retryAfterSec),
      },
    },
  );
}

export function _reset(): void {
  _resetBuckets();
  const g = globalThis as unknown as Record<string, State | undefined>;
  delete g[STATE_KEY];
}
