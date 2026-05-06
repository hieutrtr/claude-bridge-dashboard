// P2-T10 — pure optimistic-mutation helper. The dashboard does not
// (yet) use React Query, so the optimistic lifecycle is captured here
// in a dependency-free helper that mirrors `useMutation`'s
// onMutate / onError / onSuccess hooks. See `docs/tasks/phase-2/
// T10-optimistic.md` AC-1.

import { describe, it, expect } from "bun:test";

import { runOptimistic } from "../../src/lib/optimistic";

describe("runOptimistic", () => {
  it("invokes apply, then awaits fetcher, and resolves with its value", async () => {
    const calls: string[] = [];
    const result = await runOptimistic({
      apply: () => {
        calls.push("apply");
      },
      rollback: () => {
        calls.push("rollback");
      },
      fetcher: async () => {
        calls.push("fetcher");
        return { taskId: 7 };
      },
    });
    expect(result).toEqual({ taskId: 7 });
    // Rollback never runs on the success path.
    expect(calls).toEqual(["apply", "fetcher"]);
  });

  it("calls rollback when the fetcher rejects, and rethrows the original error by identity", async () => {
    const sentinel = new Error("boom");
    let rolledBack = false;
    let caught: unknown = null;
    try {
      await runOptimistic({
        apply: () => {},
        rollback: () => {
          rolledBack = true;
        },
        fetcher: async () => {
          throw sentinel;
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(rolledBack).toBe(true);
    // Identity match — same object, not a wrapped copy. Critical so
    // call sites can `instanceof DispatchError`.
    expect(caught).toBe(sentinel);
  });

  it("does not invoke fetcher or rollback when apply throws synchronously", async () => {
    const sentinel = new Error("apply-died");
    let fetcherCalls = 0;
    let rolledBack = false;
    let caught: unknown = null;
    try {
      await runOptimistic({
        apply: () => {
          throw sentinel;
        },
        rollback: () => {
          rolledBack = true;
        },
        fetcher: async () => {
          fetcherCalls++;
          return null;
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(sentinel);
    expect(fetcherCalls).toBe(0);
    expect(rolledBack).toBe(false);
  });

  it("rethrows the fetcher error even when rollback itself throws (rollback failure logged, not surfaced)", async () => {
    const fetcherError = new Error("fetcher-boom");
    const rollbackError = new Error("rollback-boom");
    const logged: unknown[] = [];
    let caught: unknown = null;
    try {
      await runOptimistic({
        apply: () => {},
        rollback: () => {
          throw rollbackError;
        },
        fetcher: async () => {
          throw fetcherError;
        },
        logError: (err) => {
          logged.push(err);
        },
      });
    } catch (err) {
      caught = err;
    }
    // Caller sees the fetcher error — the original mutation outcome.
    expect(caught).toBe(fetcherError);
    // Rollback failure is captured for observability without blocking
    // the caller's error-handling branch.
    expect(logged.length).toBe(1);
    expect(logged[0]).toBe(rollbackError);
  });

  it("invokes apply synchronously before the fetcher resolves (perceived-latency contract)", async () => {
    // The optimistic state must be visible to the user before the
    // network round-trip resolves. We exercise the contract with a
    // manually-deferred Promise: between `runOptimistic` returning
    // (the `await` point) and the deferred resolution, `apply` MUST
    // have been called already.
    let applied = 0;
    let release: (v: { ok: true }) => void = () => {};
    const deferred = new Promise<{ ok: true }>((resolve) => {
      release = resolve;
    });
    const promise = runOptimistic({
      apply: () => {
        applied++;
      },
      rollback: () => {},
      fetcher: () => deferred,
    });
    // Even before the fetcher's promise has any tick to run, `apply`
    // must already have run (it ran synchronously in the helper).
    expect(applied).toBe(1);
    release({ ok: true });
    const result = await promise;
    expect(result).toEqual({ ok: true });
    expect(applied).toBe(1); // not called twice
  });
});
