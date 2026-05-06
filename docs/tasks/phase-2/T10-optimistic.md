# P2-T10 — Optimistic UI updates + rollback

> Loop step **12 / 15**. Builds on top of T01 (`tasks.dispatch`),
> T03 (`tasks.kill`), T02 (dispatch dialog), T11 (`<KillTaskButton>` +
> `<DangerConfirm>`).

## Title

Optimistic UI updates with rollback for **dispatch + kill** mutations.
`loops.approve` / `loops.reject` are **server-confirmed** (no
optimistic) per `docs/PHASE-2-REVIEW.md` §d.1.

## References

- `docs/PHASE-2-REVIEW.md` §d.1 — *Optimistic UI scope*: dispatch + kill
  only; loop approve/reject is server-confirmed because the daemon may
  have already accepted the same action from Telegram.
- v1 ARCH §11 *Performance* — perceived-latency target for mutation
  feedback < 50 ms (the optimistic transition runs synchronously in the
  click handler before the network round-trip resolves).
- v2 ARCH §10 *Security* — optimistic UI does NOT skip CSRF/rate-limit;
  the network call still happens, the rollback is **only** the visual
  state, never the audit log entry.

## Why this is non-trivial in this codebase

The original task spec mentions React Query `useMutation`
`onMutate` / `onError`. This dashboard does **not** use React Query —
it uses the tRPC HTTP fetch adapter directly with `useState` islands.
T10 therefore lands a small, dependency-free helper module
(`src/lib/optimistic.ts`) that captures the same lifecycle:

```
runOptimistic({ apply, rollback, fetcher }):
  apply()                        # synchronous visual state change
  try:
      result = await fetcher()
      return result              # apply stays — server confirmed
  catch (err):
      rollback()                 # revert visual state
      throw err                  # caller surfaces the error envelope
```

This mirrors React Query's `onMutate` (apply) / `onError` (rollback) /
`onSuccess` (no-op, apply already happened) callbacks without dragging
in `@tanstack/react-query` (~50 KB gzipped). When the codebase migrates
to React Query in a future phase, the helper retires and the call
sites use the RQ hooks directly — the wire format does not change.

## Acceptance criteria

### AC-1 — Pure optimistic helper

- `src/lib/optimistic.ts` exports `runOptimistic({ apply, rollback,
  fetcher })`. Pure (no DOM, no React).
- `apply()` is invoked synchronously **before** `fetcher()` is awaited.
- On a fetcher resolve, the result is returned and `rollback` is
  **not** called.
- On a fetcher reject, `rollback()` is invoked **before** the original
  error is rethrown. The rethrown error preserves identity (same
  reference, no wrapping) so call sites can use `instanceof
  DispatchError`.
- `apply` and `rollback` exceptions do not corrupt the lifecycle:
  if `apply` throws, `fetcher` is not called and the error propagates;
  if `rollback` throws after a fetcher rejection, the helper still
  rethrows the original fetcher error (rollback's failure is silently
  swallowed, but the helper logs to `console.error` so a future
  observability pass can trace it).

### AC-2 — Optimistic kill on `/tasks/[id]`

- New client island `<TaskKillControl>` replaces the inline
  `<Badge>` + `<KillTaskButton>` pair in `app/tasks/[id]/page.tsx`'s
  `<TaskHeader>`.
- The control owns one piece of optimistic state: the *visual*
  task status. Initial value = the server-rendered `task.status`.
- When the user confirms the kill in `<DangerConfirm>`:
  1. Synchronously, before the network round-trip starts, the visual
     status flips to `killing` (a new badge variant — see "Visual
     state matrix" below). The Kill button hides (it's already
     terminal-checked, but the optimistic override beats the server
     status).
  2. `tasks.kill` runs. On resolve, the visual status flips to `killed`
     (or stays `killing` momentarily then `killed`). On reject, the
     visual status rolls back to the original `task.status` and the
     Kill button reappears so the user can retry. The `<DangerConfirm>`
     itself shows the error envelope per existing T11 behavior.
- The optimistic flip happens *only* on the same client; refreshing
  the page re-reads the daemon DB. This is intentional: the daemon is
  the source of truth, optimism is a UX-only veneer.
- A test fixture renders the `<TaskKillControlView>` (pure presentational
  inner component) with `optimisticStatus: "killing" | "killed" | null`
  and asserts the badge label + the Kill-button visibility match.

### AC-3 — Optimistic dispatch — preserve form on error

- The `<DispatchDialog>` already cycles `idle → submitting → success` /
  `error`. T10 codifies the rollback:
  - On `error`, the form values (`agentName`, `prompt`, `model`)
    **MUST** be preserved — the user's typed input is never silently
    dropped.
  - On `error`, the submit button re-enables so the user can retry.
- A new test case in `tests/app/dispatch-dialog.test.ts` walks the
  state matrix `idle → submitting → error` and asserts:
  - The textarea still contains the original prompt text (the `prompt`
    prop was preserved across the transition).
  - The submit button is enabled (no `disabled` attribute).
  - The error banner contains the `errorCode` + `errorMessage`.
- A test in `tests/lib/dispatch-client.test.ts` verifies that
  `parseTrpcResponse` rethrowing `DispatchError` keeps the original
  error reference (so the dialog's `catch` branch sees the typed code).
  This test piggy-backs on the optimistic-helper's "rejection identity"
  invariant (AC-1 third bullet).

### AC-4 — `loops.approve` / `loops.reject` stay server-confirmed

- No optimistic state added to the loop approve/reject path.
- A doc-only comment in the loop UI client (when it lands in T09 or
  later) calls out the rationale (§d.1 review). T10 does not write
  loop approval UI; it only documents the invariant in
  `T10-optimistic.md` (this file).

## TDD plan

### RED tests — `src/lib/optimistic.ts`

`tests/lib/optimistic.test.ts`:

1. `runOptimistic` calls `apply` then `fetcher` then resolves → no
   `rollback`.
2. `runOptimistic` calls `apply` then `fetcher` rejects → `rollback`
   called once, original error rethrown by **identity**.
3. `apply` throws → `fetcher` not called, error rethrown unchanged.
4. `rollback` throws after a fetcher rejection → original fetcher
   error still rethrown; rollback's error suppressed (but logged via a
   `logError` injection point, default `console.error`, swappable in
   tests).
5. `apply` runs **synchronously before** the awaited fetcher: assert
   by giving `fetcher` a Promise that resolves on a manual deferred,
   and inspecting the side-effect counter at the await point (counter
   is 1 before the deferred resolves).

### RED tests — `<TaskKillControlView>`

`tests/app/task-kill-control.test.ts`:

1. `optimisticStatus=null`, `serverStatus="running"` → renders the
   `<Badge>` with `running` variant + the `<KillTaskButton>` trigger.
2. `optimisticStatus="killing"` → renders a "Killing…" badge variant
   and **hides** the Kill button (the action is in flight; clicking
   again would double-fire).
3. `optimisticStatus="killed"`, `serverStatus="running"` → renders a
   "Killed" badge (variant "idle"), no Kill button.
4. `optimisticStatus=null`, `serverStatus="killed"` → no Kill button
   (server-side terminal state still wins).
5. After rollback (simulated by `optimisticStatus=null`,
   `serverStatus="running"`), the Kill button is **back** so the user
   can retry. (Same as case 1, but documents the rollback contract.)
6. Orphan task (`agentName=null`) — Kill button never renders, badge
   still does.

### RED test — dispatch rollback preserves form

`tests/app/dispatch-dialog.test.ts` adds:

- `error` state with non-empty `prompt`, `agentName`, `model`. Asserts:
  - `<textarea name="prompt">` contains the prompt value.
  - `<select name="agentName">` has the right option selected.
  - The model `<input>` value is preserved.
  - Submit button is enabled.
  - Error banner contains the code + message.

### GREEN — implementation order

1. Write `src/lib/optimistic.ts`. Run `tests/lib/optimistic.test.ts`.
2. Add `<TaskKillControl>` + `<TaskKillControlView>` in
   `src/components/task-kill-control.tsx`. Wire `KillTaskButton` to
   call `runOptimistic` via two new optional callback props:
   `onOptimisticBegin?(): void` (apply) + `onOptimisticRollback?():
   void` (rollback). Existing call sites that don't pass these
   callbacks behave identically (backward compatible).
3. Replace the inline `<Badge>` + `<KillTaskButton>` in
   `app/tasks/[id]/page.tsx`'s `<TaskHeader>` with `<TaskKillControl>`.
4. Add the dispatch-form-preserved-on-error test case. The existing
   `<DispatchDialogView>` already preserves the form across status
   transitions because its props are externally controlled — no code
   change needed; the test pins this contract.

### Refactor

- The `<KillTaskButton>` no longer needs to render the Kill trigger
  in isolation; it is now consumed by `<TaskKillControl>`. Keep
  `<KillTaskButton>` as a public export (other surfaces in future
  phases — e.g. an inline kill in a task list — will reuse it
  without the badge).

## Risk & mitigation (from `docs/PHASE-2-REVIEW.md`)

- **Risk: Low** (per review §c). React Query convention; the wire
  contract is already exercised by T03 + T11.
- **Mitigation 1**: pure helper isolates the lifecycle so a future
  React Query migration is a swap, not a rewrite.
- **Mitigation 2**: `<TaskKillControlView>` is a pure render of state,
  unit-testable with `renderToStaticMarkup`. The interactive wrapper
  is exercised by Playwright in step 14.
- **Mitigation 3**: optimistic state is cleared on rollback to avoid
  the dreaded "ghost killed task" footgun where the user retries and
  the badge says killed despite the daemon still running it.

## Out of scope

- Optimistic UI for any loop mutation (T06 / T09) — server-confirmed
  per review.
- Migration to React Query — Phase 4 candidate. The helper is the
  bridge.
- A toast/notification primitive — T10 surfaces feedback inline in
  the page header. A toast layer is a separate task (deferred).
- Animations / transitions on the badge flip — pure functional render
  is enough; no `framer-motion`.
- SSE-driven status invalidation — when SSE wires a `tasks` channel
  (Phase 3 or later), the optimistic override merges with the live
  status from the server stream. Out of scope for T10.
