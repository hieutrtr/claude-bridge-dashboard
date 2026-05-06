# P2-T10 — Self-review (optimistic UI + rollback)

> Spec: `docs/tasks/phase-2/T10-optimistic.md`. Loop step 12 / 15.

## Files changed

| Path                                                                     | Lines | Note                                          |
|--------------------------------------------------------------------------|-------|-----------------------------------------------|
| `src/lib/optimistic.ts`                                                  | +66   | Pure helper: `runOptimistic({apply,rollback,fetcher,logError?})` mirroring React Query's `useMutation` lifecycle without the dependency. |
| `src/components/task-kill-control.tsx`                                   | +127  | New client island. `<TaskKillControlView>` (pure render of the optimistic state matrix) + `<TaskKillControl>` (wraps the view, owns `optimisticStatus` via `useState`, threads three callbacks into `<KillTaskButton>`). |
| `src/components/kill-task-button.tsx`                                    | +21/-2| Adds `onOptimisticBegin?` / `onOptimisticSettle?` / `onOptimisticRollback?` props. The dialog's `onSubmit` now wraps the network call in `runOptimistic`. Backwards-compatible — existing callers without callbacks behave identically. |
| `app/tasks/[id]/page.tsx`                                                | +5/-9 | `<TaskHeader>` swaps the inline `<Badge>` + `<KillTaskButton>` for a single `<TaskKillControl>`. Drops the now-unused `Badge` + `taskStatusBadge` imports + the `badge` prop on `<TaskHeader>`. |
| `tests/lib/optimistic.test.ts`                                           | +110  | 5 cases: success path, error rollback (identity-preserving rethrow), apply throws (no fetcher / no rollback), rollback throws (logged not surfaced), apply runs synchronously before fetcher resolves. |
| `tests/app/task-kill-control.test.ts`                                    | +88   | 6 cases over the optimistic-state matrix: idle running / killing / killed (optimistic) / killed (server) / rollback returned to idle / orphan task. |
| `tests/app/dispatch-dialog.test.ts`                                      | +37   | One new case pinning the *form-preserved-on-error* invariant (P2-T10 AC-3). |
| `docs/tasks/phase-2/T10-optimistic.md`                                   | new   | Task spec — references PHASE-2-REVIEW §d.1, AC matrix, TDD plan. |

Total: ~10 expects, 12 new test cases, 0 net dependency change.

## Test count delta

- Before T10: 510 / 510 pass (47 files).
- After T10:  **523 / 523 pass** (48 files; 1 new test file
  `tests/lib/optimistic.test.ts`, 1 new test file
  `tests/app/task-kill-control.test.ts`, 1 augmented file
  `tests/app/dispatch-dialog.test.ts`).
- `bun run typecheck` clean.
- `bun run test` clean (excludes Playwright `tests/e2e/**` per the
  package.json script).

## Self-review checklist

- [x] **Tests cover happy + error paths.** `runOptimistic` has both
      branches plus the apply-throws and rollback-throws degenerate
      cases. `<TaskKillControlView>` covers the full
      (`optimisticStatus` × `serverStatus`) matrix that real users
      can produce.
- [x] **Mutation has audit log entry.** Untouched: T01 / T03 / T06
      already write `audit_log` from the tRPC procedure. T10 is a
      *client*-side change — it does not fork the wire format and
      cannot bypass the audit. The optimistic visual flip happens on
      the same client; the server-side path is unchanged.
- [x] **CSRF token check.** Untouched: `<KillTaskButton>` already
      reads `bridge_csrf_token` and aborts with `FORBIDDEN` when it's
      absent. T10 wraps the same network call in `runOptimistic`; the
      CSRF check happens *before* `apply` is called (we read the
      cookie in `onSubmit` and throw before entering the helper).
- [x] **Rate limit applied.** Untouched: the `tasks.kill` tRPC
      mutation goes through the rate-limit middleware (T07). The
      optimistic UI flip cannot bypass the limit because the network
      call still happens — if the limiter returns 429, the helper
      sees a `DispatchError("TOO_MANY_REQUESTS", ...)`, calls
      rollback, and rethrows. The kill button is back, the badge is
      back to `running`, and the `<DangerConfirm>` shows the typed
      error envelope.
- [x] **Optimistic update has rollback.** `runOptimistic` rejects
      tests prove `rollback()` is called once and only once on a
      fetcher rejection; component-level test 5
      ("after rollback the Kill trigger reappears") pins the visual
      contract. Identity-preserving rethrow guarantees call sites can
      still `instanceof DispatchError`.
- [x] **Confirmation pattern for destructive action.** Unchanged:
      `<TaskKillControl>` still routes through `<DangerConfirm>` (T11).
      The user must still type the agent name to enable the action.
- [x] **No secret leak.** No new secret surface. The CSRF cookie
      reader and the agent name (already public) are the only
      identifiers touched. No PII is added to log lines —
      `defaultLogError` only logs the rollback error stack.

## Architectural concerns addressed (review §d)

- **§d.1 Optimistic UI scope** — Encoded in T10 as planned: dispatch
  + kill optimistic, `loops.approve` / `loops.reject` server-confirmed.
  The dispatch optimistic surface is "preserve form on error so user
  can retry", which AC-3 verifies. The kill optimistic surface is the
  badge flip + button hide, which AC-2 verifies. The loop approve /
  reject path was not touched (no T10 change in `src/components/`
  or `src/server/routers/loops.ts`).

## Risk recap

- **Risk: Low** (per review §c). Confirmed:
  - The new `runOptimistic` helper is pure, isolated, and testable
    without React. Future React Query migration is a callback swap.
  - The `<TaskKillControl>` wrapper is a thin `useState` over the
    pure view; both layers are independently tested.
  - No daemon-side changes; wire format and `audit_log` rows are
    identical to T03's pre-T10 state.
- **Trade-off accepted**: T10 ships a hand-rolled optimistic helper
  rather than `@tanstack/react-query`. ~50 KB gzipped saved in the
  client bundle, at the cost of one helper function and one wrapper
  component to maintain. When a third optimistic mutation is added
  (likely T09 permission relay or a Phase 3 schedule edit), revisit
  whether to migrate to React Query.
- **Trade-off accepted**: the optimistic state lives on a single
  client. Two open tabs viewing the same task will not see each
  other's optimistic flips. Refresh / SSE-driven invalidation
  reconciles. This matches the daemon-as-source-of-truth invariant.

## Out-of-scope follow-ups

- **Toast / global notification primitive.** Today the success and
  error states render *inside* the `<DangerConfirm>` dialog. A
  global `<Toaster>` (e.g. `sonner`) would give the user feedback
  even after they close the dialog. Phase 3 candidate.
- **SSE-driven status invalidation.** When a future SSE channel
  carries `task.status` updates, the optimistic override should
  *clear* itself the moment the daemon-confirmed status arrives.
  Today the override sticks until the page is refreshed. Phase 3
  candidate.
- **Dispatch toast linking to `/tasks/[id]`.** The dispatch dialog
  currently shows the new task id inline as a `<Link>`. A toast
  outside the modal would let the user keep dispatching without
  having to dismiss the success state. Phase 3 candidate.

## Sign-off

T10 lands the optimistic-update + rollback contract for `tasks.kill`
on `/tasks/[id]` and pins the form-preservation rollback for
`tasks.dispatch`. All 523 tests green; typecheck clean.

12 / 12 Phase-2 atomic tasks now complete (T01..T08, T11, T12, T05,
**T10**) plus T09 (permission relay) deferred per review §d's
risk-tier table. T09, the phase test sweep (step 14), and the phase
sign-off (step 15) remain.
