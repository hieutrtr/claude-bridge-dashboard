// Rate-limit guard for the /api/auth/login route. Pre-session, so the
// bucket is keyed on IP only. See docs/tasks/phase-2/T07-rate-limit.md
// and v1 ARCH §10 (5/min/IP brute-force lockout).

import { _resetBuckets, consume, createBucket, type Bucket } from "@/src/lib/rate-limit";
import { appendAudit } from "@/src/server/audit";

const DEFAULT_PER_MIN = 5;
const STATE_KEY = "__bridge_rate_limit_login__";

interface State {
  bucket: Bucket;
  capacity: number;
}

function readCapacity(): number {
  const raw = process.env.RATE_LIMIT_LOGIN_PER_MIN;
  if (raw === undefined) return DEFAULT_PER_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PER_MIN;
  return Math.floor(n);
}

function getState(): State {
  const g = globalThis as unknown as Record<string, State | undefined>;
  const cached = g[STATE_KEY];
  const capacity = readCapacity();
  if (cached && cached.capacity === capacity) return cached;
  const fresh: State = {
    capacity,
    bucket: createBucket({ capacity, refillPerSec: capacity / 60 }),
  };
  g[STATE_KEY] = fresh;
  return fresh;
}

export async function rateLimitLogin(req: Request): Promise<Response | null> {
  const { bucket, capacity } = getState();
  if (capacity === 0) return null;

  const key = clientIp(req) ?? "unknown";
  const result = consume(bucket, key);
  if (result.ok) return null;

  appendAudit({
    action: "rate_limit_blocked",
    resourceType: "auth",
    payload: { retryAfterSec: result.retryAfterSec, scope: "login" },
    req,
  });

  return new Response(
    JSON.stringify({ error: "rate_limited", retryAfterSec: result.retryAfterSec }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "Retry-After": String(result.retryAfterSec),
      },
    },
  );
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

export function _reset(): void {
  _resetBuckets();
  const g = globalThis as unknown as Record<string, State | undefined>;
  delete g[STATE_KEY];
}
