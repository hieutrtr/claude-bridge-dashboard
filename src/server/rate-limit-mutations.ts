// Rate-limit guard for state-changing requests. Pairs with csrfGuard at
// the tRPC POST entry. Key = sessionUserId when authed, else first hop
// of x-forwarded-for (or x-real-ip), else "unknown". See
// docs/tasks/phase-2/T07-rate-limit.md.

import { _resetBuckets, consume, createBucket, type Bucket } from "@/src/lib/rate-limit";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_PER_MIN = 30;

interface State {
  bucket: Bucket;
  capacity: number;
}

const STATE_KEY = "__bridge_rate_limit_mutations__";

function readCapacity(): number {
  const raw = process.env.RATE_LIMIT_MUTATIONS_PER_MIN;
  if (raw === undefined) return DEFAULT_PER_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PER_MIN;
  return Math.floor(n);
}

function getState(): State {
  // The state lives on globalThis so HMR / dev-server reloads don't blow
  // the bucket away mid-request.
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

export async function rateLimitMutations(
  req: Request,
  sessionUserId: string | null,
): Promise<Response | null> {
  if (SAFE_METHODS.has(req.method)) return null;

  const { bucket, capacity } = getState();
  // capacity = 0 disables the guard entirely (debug escape hatch).
  if (capacity === 0) return null;

  const key = sessionUserId ?? clientIp(req) ?? "unknown";
  const result = consume(bucket, key);
  if (result.ok) return null;

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

// Debug-only — reset the singleton bucket. Tests use this in `beforeEach`
// to start from a clean slate. Also clears the global cache so that an
// env override (RATE_LIMIT_MUTATIONS_PER_MIN) takes effect on the next
// `rateLimitMutations` call.
export function _reset(): void {
  _resetBuckets();
  const g = globalThis as unknown as Record<string, State | undefined>;
  delete g[STATE_KEY];
}
