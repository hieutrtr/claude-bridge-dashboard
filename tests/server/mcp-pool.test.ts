import { describe, it, expect } from "bun:test";
import { join } from "node:path";

import { McpPool, McpPoolError } from "../../src/server/mcp/pool";

const FIXTURE = join(import.meta.dir, "fixtures", "mock-mcp-server.mjs");

function makePool(opts: Partial<ConstructorParameters<typeof McpPool>[0]> = {}) {
  return new McpPool({
    command: "bun",
    args: [FIXTURE],
    queueCap: 128,
    timeoutMs: 5_000,
    ...opts,
  });
}

describe("McpPool", () => {
  it("returns the result of a single round-trip", async () => {
    const pool = makePool();
    try {
      const res = await pool.call("echo", { hello: "world" });
      expect(res).toEqual({ ok: true, echoed: { hello: "world" } });
    } finally {
      await pool.close();
    }
  });

  it("100 parallel calls reuse exactly one child process", async () => {
    const pool = makePool();
    try {
      const t0 = performance.now();
      const promises = Array.from({ length: 100 }, (_, i) =>
        pool.call("echo", { i }).then((r) => ({ i, r, t: performance.now() - t0 })),
      );
      const results = await Promise.all(promises);
      // All resolved correctly.
      for (const { i, r } of results) {
        expect(r).toEqual({ ok: true, echoed: { i } });
      }
      // Exactly one child process was spawned.
      expect(pool.spawnCount).toBe(1);
      // p95 < 500 ms.
      const lat = results.map((x) => x.t).sort((a, b) => a - b);
      const p95 = lat[Math.floor(lat.length * 0.95)]!;
      expect(p95).toBeLessThan(500);
    } finally {
      await pool.close();
    }
  });

  it("routes out-of-order responses by id", async () => {
    const pool = makePool();
    try {
      // Slow request kicks off first; echo returns immediately.
      const slow = pool.call("slow", { ms: 200, marker: "slow" });
      // Tiny gap to ensure the slow request was sent first.
      await new Promise((r) => setTimeout(r, 10));
      const fast = pool.call("echo", { marker: "fast" });
      const fastFirst = await Promise.race([
        slow.then(() => "slow"),
        fast.then(() => "fast"),
      ]);
      expect(fastFirst).toBe("fast");
      const slowResult = await slow;
      expect(slowResult).toEqual({
        ok: true,
        echoed: { ms: 200, marker: "slow" },
      });
      const fastResult = await fast;
      expect(fastResult).toEqual({ ok: true, echoed: { marker: "fast" } });
    } finally {
      await pool.close();
    }
  });

  it("rejects in-flight calls with MCP_CONNECTION_LOST when child crashes", async () => {
    const pool = makePool();
    try {
      // Send an echo first to make sure the child is alive and warm.
      await pool.call("ping", {});
      // Now fire two slow calls and a crash; the crash kills the child while
      // the slow calls are pending.
      const slow1 = pool.call("slow", { ms: 1000 });
      const slow2 = pool.call("slow", { ms: 1000 });
      // Tiny delay to ensure slow calls are routed before crash.
      await new Promise((r) => setTimeout(r, 30));
      // Send crash; this never resolves on the server side.
      const crashCall = pool.call("crash", {}).catch((e) => e);
      const [r1, r2, rc] = await Promise.all([
        slow1.catch((e) => e),
        slow2.catch((e) => e),
        crashCall,
      ]);
      for (const r of [r1, r2, rc]) {
        expect(r).toBeInstanceOf(McpPoolError);
        expect((r as McpPoolError).code).toBe("MCP_CONNECTION_LOST");
      }
    } finally {
      await pool.close();
    }
  });

  it("transparently respawns on the next call after a crash", async () => {
    const pool = makePool();
    try {
      await pool.call("ping", {});
      expect(pool.spawnCount).toBe(1);
      // Trigger crash and let in-flight settle.
      await pool.call("crash", {}).catch(() => {});
      // Next call must spawn a fresh child and succeed.
      const r = await pool.call("ping", {});
      expect(r).toBe("pong");
      expect(pool.spawnCount).toBe(2);
    } finally {
      await pool.close();
    }
  });

  it("rejects with MCP_BACKPRESSURE when the queue cap is exceeded", async () => {
    const pool = makePool({ queueCap: 2 });
    try {
      // Two slow calls fill the queue.
      const a = pool.call("slow", { ms: 200 });
      const b = pool.call("slow", { ms: 200 });
      // Third call must reject immediately.
      const c = pool.call("echo", { i: 3 }).catch((e) => e);
      const err = await c;
      expect(err).toBeInstanceOf(McpPoolError);
      expect((err as McpPoolError).code).toBe("MCP_BACKPRESSURE");
      // First two still resolve.
      await Promise.all([a, b]);
    } finally {
      await pool.close();
    }
  });

  it("AbortController.abort() rejects the call without poisoning sibling routing", async () => {
    const pool = makePool();
    try {
      const ac = new AbortController();
      const slow = pool.call("slow", { ms: 1000 }, { signal: ac.signal });
      // Ensure the call is in-flight, then abort.
      await new Promise((r) => setTimeout(r, 30));
      ac.abort();
      const err = await slow.catch((e) => e);
      expect(err).toBeInstanceOf(McpPoolError);
      expect((err as McpPoolError).code).toBe("MCP_ABORTED");
      // Subsequent unrelated call still works (id routing not poisoned).
      const ok = await pool.call("ping", {});
      expect(ok).toBe("pong");
    } finally {
      await pool.close();
    }
  });

  it("rejects with MCP_TIMEOUT after the configured deadline", async () => {
    const pool = makePool({ timeoutMs: 100 });
    try {
      const err = await pool
        .call("slow", { ms: 1000 })
        .catch((e) => e);
      expect(err).toBeInstanceOf(McpPoolError);
      expect((err as McpPoolError).code).toBe("MCP_TIMEOUT");
      // Sibling call still works.
      const ok = await pool.call("ping", {}, { timeoutMs: 2000 });
      expect(ok).toBe("pong");
    } finally {
      await pool.close();
    }
  });

  it("close() drains pending and rejects with MCP_CONNECTION_CLOSED", async () => {
    const pool = makePool();
    await pool.call("ping", {}); // warm up
    const slow = pool.call("slow", { ms: 1000 }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 30));
    await pool.close();
    const err = await slow;
    expect(err).toBeInstanceOf(McpPoolError);
    expect((err as McpPoolError).code).toBe("MCP_CONNECTION_CLOSED");
  });

  it("close() is idempotent", async () => {
    const pool = makePool();
    await pool.call("ping", {});
    await pool.close();
    await pool.close(); // should not throw
    // Calling on a closed pool fails fast.
    const err = await pool.call("ping", {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpPoolError);
    expect((err as McpPoolError).code).toBe("MCP_CONNECTION_CLOSED");
  });
});
