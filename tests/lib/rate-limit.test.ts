import { describe, it, expect, beforeEach } from "bun:test";

import {
  _bucketCount,
  _resetBuckets,
  consume,
  createBucket,
} from "../../src/lib/rate-limit";

beforeEach(() => {
  _resetBuckets();
});

describe("rate-limit token bucket", () => {
  it("starts at full capacity — first consume succeeds", () => {
    const b = createBucket({ capacity: 5, refillPerSec: 1 });
    const r = consume(b, "k", 0);
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(4);
    expect(r.retryAfterSec).toBe(0);
  });

  it("exhausts after `capacity` rapid calls; the next is denied", () => {
    const b = createBucket({ capacity: 5, refillPerSec: 1 });
    for (let i = 0; i < 5; i++) {
      expect(consume(b, "k", 0).ok).toBe(true);
    }
    const denied = consume(b, "k", 0);
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSec).toBe(1);
  });

  it("refills over time — denied request becomes allowed after 1s at 1/s", () => {
    const b = createBucket({ capacity: 5, refillPerSec: 1 });
    for (let i = 0; i < 5; i++) {
      consume(b, "k", 0);
    }
    expect(consume(b, "k", 0).ok).toBe(false);
    const r = consume(b, "k", 1000);
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it("refill is capped at `capacity` — waiting an hour does not grant 3600 tokens", () => {
    const b = createBucket({ capacity: 5, refillPerSec: 1 });
    for (let i = 0; i < 5; i++) consume(b, "k", 0);
    // 1 hour later — bucket should be at 5 (cap), not 3600
    const after = consume(b, "k", 60 * 60 * 1000);
    expect(after.ok).toBe(true);
    expect(after.remaining).toBe(4);
  });

  it("keys are independent — exhausting one does not block another", () => {
    const b = createBucket({ capacity: 3, refillPerSec: 1 });
    for (let i = 0; i < 3; i++) consume(b, "a", 0);
    expect(consume(b, "a", 0).ok).toBe(false);
    expect(consume(b, "b", 0).ok).toBe(true);
  });

  it("retryAfterSec is ceil((1 - tokens) / refillPerSec) — never zero on a deny", () => {
    // refillPerSec = 0.5 (mutation policy: 30/min)
    const b = createBucket({ capacity: 30, refillPerSec: 0.5 });
    for (let i = 0; i < 30; i++) consume(b, "u", 0);
    const r = consume(b, "u", 0);
    expect(r.ok).toBe(false);
    expect(r.retryAfterSec).toBe(2); // need 1 token, refill 0.5/s → 2s
  });

  it("retryAfterSec decreases monotonically as time passes (sanity)", () => {
    const b = createBucket({ capacity: 5, refillPerSec: 1 });
    for (let i = 0; i < 5; i++) consume(b, "k", 0);
    const r0 = consume(b, "k", 0).retryAfterSec;
    const r500 = consume(b, "k", 500).retryAfterSec;
    expect(r0).toBeGreaterThanOrEqual(r500);
    expect(r0).toBeGreaterThan(0);
    expect(r500).toBeGreaterThanOrEqual(0);
  });

  it("evicts idle full buckets after 10 minutes (memory bound)", () => {
    const b = createBucket({ capacity: 1, refillPerSec: 10 });
    // create 1500 distinct keys — all consume once, all refill to full
    for (let i = 0; i < 1500; i++) {
      consume(b, `k${i}`, 0);
    }
    // 11 minutes later, one fresh consume triggers GC
    consume(b, "trigger", 11 * 60 * 1000);
    // We can't make a strict guarantee about exact count (GC runs every
    // Nth consume), but we should be well below 1500 + 1.
    expect(_bucketCount(b)).toBeLessThan(1024);
  });

  it("disabled bucket (capacity = 0) — every consume returns ok:true", () => {
    const b = createBucket({ capacity: 0, refillPerSec: 0 });
    for (let i = 0; i < 100; i++) {
      expect(consume(b, "k", i * 1000).ok).toBe(true);
    }
  });

  it("_resetBuckets clears state across buckets", () => {
    const b = createBucket({ capacity: 1, refillPerSec: 0 });
    consume(b, "k", 0);
    expect(consume(b, "k", 0).ok).toBe(false);
    _resetBuckets();
    expect(consume(b, "k", 0).ok).toBe(true);
  });
});
