// Token-bucket rate limiter — single-process, in-memory. Used by the
// dashboard's mutation guard (per-user) and login guard (per-IP).
// See docs/tasks/phase-2/T07-rate-limit.md for the policy.

export interface BucketOpts {
  capacity: number;
  refillPerSec: number;
}

export interface ConsumeResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

interface Entry {
  tokens: number;
  updatedAtMs: number;
}

export interface Bucket {
  capacity: number;
  refillPerSec: number;
  entries: Map<string, Entry>;
  consumeCount: number;
}

const ALL_BUCKETS = new Set<Bucket>();

const GC_EVERY = 64;
const IDLE_EVICT_MS = 10 * 60 * 1000;

export function createBucket(opts: BucketOpts): Bucket {
  const b: Bucket = {
    capacity: opts.capacity,
    refillPerSec: opts.refillPerSec,
    entries: new Map(),
    consumeCount: 0,
  };
  ALL_BUCKETS.add(b);
  return b;
}

export function consume(bucket: Bucket, key: string, now?: number): ConsumeResult {
  // Disabled bucket: capacity 0 = unlimited (used by env override).
  if (bucket.capacity === 0) {
    return { ok: true, remaining: 0, retryAfterSec: 0 };
  }

  const nowMs = now ?? Date.now();
  let entry = bucket.entries.get(key);
  if (!entry) {
    entry = { tokens: bucket.capacity, updatedAtMs: nowMs };
    bucket.entries.set(key, entry);
  } else {
    const elapsedSec = Math.max(0, (nowMs - entry.updatedAtMs) / 1000);
    entry.tokens = Math.min(bucket.capacity, entry.tokens + elapsedSec * bucket.refillPerSec);
    entry.updatedAtMs = nowMs;
  }

  bucket.consumeCount++;
  // GC runs every Nth consume (cheap amortised cost) AND eagerly whenever
  // the map is unusually large (pathological burst safety net).
  if (bucket.consumeCount % GC_EVERY === 0 || bucket.entries.size > 1024) {
    gc(bucket, nowMs);
  }

  if (entry.tokens >= 1) {
    entry.tokens -= 1;
    return {
      ok: true,
      remaining: Math.floor(entry.tokens),
      retryAfterSec: 0,
    };
  }

  // Denied — compute the wait until 1 token accrues.
  const need = 1 - entry.tokens;
  const retryAfterSec = bucket.refillPerSec > 0
    ? Math.max(1, Math.ceil(need / bucket.refillPerSec))
    : Number.MAX_SAFE_INTEGER;
  return { ok: false, remaining: 0, retryAfterSec };
}

function gc(bucket: Bucket, nowMs: number): void {
  // Any entry idle for IDLE_EVICT_MS has by now refilled to full capacity
  // — recreating it on next consume is identical to keeping it. Drop it.
  for (const [k, e] of bucket.entries) {
    if (nowMs - e.updatedAtMs > IDLE_EVICT_MS) {
      bucket.entries.delete(k);
    }
  }
}

// Debug-only — used by tests to drive a fresh state. Not part of the
// public API surface.
export function _resetBuckets(): void {
  for (const b of ALL_BUCKETS) {
    b.entries.clear();
    b.consumeCount = 0;
  }
}

export function _bucketCount(bucket: Bucket): number {
  return bucket.entries.size;
}
