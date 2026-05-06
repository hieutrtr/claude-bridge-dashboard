// P2-T10 — pure optimistic-mutation helper. The dashboard does not
// (yet) use React Query, so the optimistic lifecycle that React Query
// wires through `useMutation`'s `onMutate` / `onError` / `onSuccess`
// callbacks is captured here as a single async function with no
// dependencies on React or the DOM.
//
// Lifecycle:
//
//   apply()                     ← synchronous, before the network call
//   await fetcher()             ← network round-trip
//     resolve  → return value   ← apply stays
//     reject   → rollback()     ← then rethrow original error
//
// The original error is rethrown by **identity** so call sites can
// `instanceof DispatchError` (or any other typed error) without
// peeling a wrapper.

export interface OptimisticParams<T> {
  /**
   * Synchronous side-effect run *before* the fetcher is awaited. Owns
   * the optimistic visual state change (e.g. setState to "killing"). If
   * `apply` throws, the helper does NOT call the fetcher and rethrows
   * the apply error unchanged.
   */
  apply: () => void;
  /**
   * Reverts the optimistic state change. Called after a fetcher
   * rejection. If `rollback` itself throws, the helper logs via
   * `logError` and rethrows the original fetcher error (rollback's
   * failure is not surfaced to the caller).
   */
  rollback: () => void;
  /**
   * The actual mutation request. The helper does not impose a return
   * type; whatever the fetcher resolves with becomes
   * `runOptimistic`'s return value.
   */
  fetcher: () => Promise<T>;
  /**
   * Called when `rollback` itself throws after a fetcher rejection.
   * Defaults to `console.error`. Tests inject a capture function.
   */
  logError?: (err: unknown) => void;
}

export async function runOptimistic<T>(params: OptimisticParams<T>): Promise<T> {
  const log = params.logError ?? defaultLogError;

  // Apply runs first. If it throws, neither fetcher nor rollback is
  // called — the optimistic state never flipped, so there is nothing
  // to undo.
  params.apply();

  try {
    return await params.fetcher();
  } catch (fetcherError) {
    try {
      params.rollback();
    } catch (rollbackError) {
      log(rollbackError);
    }
    throw fetcherError;
  }
}

function defaultLogError(err: unknown): void {
  // Use `console.error` directly so the message lands in dev tools
  // and the Next.js server logs alike. Tests inject a capture
  // function via `logError`, so this branch is unreachable in tests.
  // eslint-disable-next-line no-console
  console.error("[optimistic] rollback threw", err);
}
