# P2-T11 — Confirmation pattern — Self-review

## Files changed

| File | Change | Notes |
|------|--------|-------|
| `src/lib/danger-confirm-client.ts` | NEW | Pure helpers: `KILL_TASK_URL`, `buildKillTaskRequest({id}, csrf)`, `isConfirmationMatch(input, expected)`. Re-exports `parseTrpcResponse`, `readCsrfTokenFromCookie`, `DispatchError` from T02's `dispatch-client.ts` so the kill button uses one toolbox. No DOM imports. |
| `src/components/danger-confirm.tsx` | NEW | `"use client"` module with two named exports: `DangerConfirmView` (pure props-driven markup, no hooks, no `document` access) and `DangerConfirm` (interactive wrapper owning `open`/`typed`/`status`/`csrfMissing` state, reading `document.cookie` once on open, awaiting parent's `onSubmit` to drive success/error). Action button uses `data-role="confirm-action"` for tests; input uses `data-role="confirm-input"`. |
| `src/components/kill-task-button.tsx` | NEW | `"use client"` consumer of `<DangerConfirm>`. Hides itself for orphan tasks (`agentName === null`) and for tasks in terminal statuses (`done|failed|killed`). Plugs the `tasks.kill` mutation into the dialog's `onSubmit` seam — the dialog itself never knows the wire format. |
| `app/tasks/[id]/page.tsx` | EDIT | Imports `<KillTaskButton>` and renders it next to the status badge in `TaskHeader`. The page stays a server component; only the button is client-side. |
| `tests/lib/danger-confirm-client.test.ts` | NEW | 15 helper tests: `KILL_TASK_URL` value, `buildKillTaskRequest` URL/method/headers/body shape (5), `isConfirmationMatch` (8) covering exact match, trim, case-sensitivity, empty input, empty expected (defence), whitespace-only, newline trim, non-match. |
| `tests/app/danger-confirm.test.ts` | NEW | 10 view tests via `renderToStaticMarkup`: `open=false` produces no dialog, open shows verb+subject, action button disabled on no-match, enabled on match, disabled while submitting (overrides match), disabled+session-hint on `csrfMissing`, success shows close button (form gone), success mentions "already terminated" when daemon raced, error shows code+message and keeps the form, Cancel button always present, input is bound to `typed` prop. |
| `tests/app/kill-task-button.test.ts` | NEW | 9 smoke tests: terminal statuses (done/failed/killed) → no Kill markup; non-terminal (running/pending/queued/unknown/null) → Kill markup; `agentName === null` → no Kill markup. |
| `docs/tasks/phase-2/T11-confirmation.md` | NEW | Task spec — refs / scope / non-goals / 7 acceptance criteria / TDD plan (3 test files, 34 cases) / impl outline / 7-row risk-mitigation table. |
| `docs/tasks/phase-2/INDEX.md` | EDIT | Flipped T11 checkbox + status line. |

## Test count

- Helper unit (`tests/lib/danger-confirm-client.test.ts`): **15 tests, ~21 expects** — green.
- View (`tests/app/danger-confirm.test.ts`): **10 tests, ~21 expects** — green.
- Button smoke (`tests/app/kill-task-button.test.ts`): **9 tests, ~9 expects** — green.
- T11 total: **34 tests / ~50 expects** — green.
- Full suite (`bun test`): **511 pass / 0 failures** (the bun summary's "1 fail / 1 error" tally is the pre-existing Playwright import error in `tests/e2e/smoke.spec.ts`, unchanged from T05). Up from 477 after T05.
- Typecheck: `bun run typecheck` (`tsc --noEmit`) — clean.
- Build: `bun run build` — clean. `/tasks/[id]` route bundle grew from 1.7 kB → **3.4 kB** (DangerConfirm wrapper + kill-task button).

## Self-review checklist

- [x] **Tests cover happy + error path.** Helper: every state of `isConfirmationMatch` + every field of `buildKillTaskRequest`. View: every status (idle/submitting/success/error) × match/mismatch × csrfMissing. Button: every status flag. Error path covered by the `status=error` view test (renders error code + message and keeps the form for retry).
- [x] **Mutation has audit log entry?** N/A at the UI layer. The dialog is *UX*, not the mutation surface. The tRPC `tasks.kill` procedure (T03) is what audits — and it audits both success and error paths regardless of how the call originated. The dialog cannot bypass T03.
- [x] **CSRF token check?** Yes — at two layers. (1) The dialog reads `document.cookie` on open and surfaces `csrfMissing=true` (disables the action button + shows a session-expired hint) if the cookie is absent. (2) `buildKillTaskRequest` always sets the `x-csrf-token` header from the supplied token. (3) The server-side T08 guard validates the header on the POST; if a determined caller skips the dialog, the server still 403s. The dialog is a UX gate, not a security gate — documented in spec §"Risk + mitigation".
- [x] **Rate limit applied?** Yes via T07 on the server side. The dialog itself does not enforce a rate limit (each click is a single submit). Repeated open→close→reopen does not fire the mutation.
- [x] **Optimistic update has rollback?** N/A — T11 ships the *naked* mutation flow. The success state shows "Killed." and a Close button; no React Query mutation, no cache update, no badge flip. T10 (next iteration) wires optimistic update + rollback on top of the same `buildKillTaskRequest` helper.
- [x] **Confirmation pattern for destructive action?** This *is* the confirmation pattern. Strict criteria: typed value must `.trim()`-equal the agent name (case-sensitive). Empty `expected` always returns false (defence against a caller forgetting to pass the token). Action button is double-disabled (no-match OR submitting OR csrfMissing).
- [x] **No secret leak.** The dialog renders the agent name (already public per the agents list), the task id (public), and the typed input (mirrored back to the user). No tokens, no error stacktraces leaked. The `errorMessage` field renders the tRPC procedure's `message`, which T03 already vets (no daemon panic strings escape — `mapMcpErrorToTrpc` only forwards typed messages).

## Notes / surprises

- **No `<AlertDialog>` from shadcn.** The v2 plan says "shadcn `<AlertDialog>`", but this repo's `src/components/ui/` only carries `badge`, `button`, `card`, `input`, `skeleton`, `theme-toggle` — no Dialog primitives (Phase 1 deliberately kept the shadcn surface narrow). Adding `<AlertDialog>` + Radix dependency for a single consumer in this iteration is heavier than the inline `fixed inset-0 …` overlay pattern that `<DispatchDialog>` (T02) already uses. We follow the same pattern. If Phase 3 needs three more dialogs, an `<AlertDialog>` migration is a clean refactor — the public prop surface of `<DangerConfirmView>` doesn't change.
- **`<DangerConfirm>` uses a `<span>` trigger, not a portal.** The trigger is rendered inline; clicking it `setOpen(true)` and the overlay paints fixed-position over the page. That avoids both the React 18 portal-during-SSR mismatch and the test surface complexity (`renderToStaticMarkup` renders the trigger and the closed dialog in one tree). The cosmetic cost is that the trigger receives a redundant `role="presentation"` so screen readers don't double-announce — the inner `<Button>` carries the semantics.
- **`onSubmit` returns `Promise<{alreadyTerminated?:boolean} | void>` rather than typed `KillTaskResult`.** Generic by design: a future `<CancelLoopButton>` will pass an `onSubmit` whose result shape is `{ ok: true }`. The dialog only needs the optional `alreadyTerminated` flag to adjust success copy; everything else is opaque. The seam is documented in `<DangerConfirm>`'s docblock.
- **Pre-hydration smoke tests via `renderToStaticMarkup`.** The button + dialog are `"use client"`, but their initial render — the trigger button — is fully deterministic. We assert that markup. The interactive flow (click trigger → dialog opens → type → submit) is exercised by Playwright in the Phase 2 step 14 sweep. Calling `renderToStaticMarkup(KillTaskButton({…}))` works because React's static renderer evaluates the function body unconditionally; `useState` is not invoked because the wrapper renders the trigger + a closed `<DangerConfirmView>` (which returns `null` for `open=false`). Tests are pure.
- **Match is case-sensitive on purpose.** Agent names are case-sensitive in the daemon's primary key (`agents(name, project_dir)`), so a confirmation that's case-insensitive could let the user think they're confirming a different agent. We trim because trailing-newline-from-paste is a real on-mobile annoyance, but case stays.
- **Empty `expected` defence.** If a future consumer wires `<DangerConfirm expectedConfirmation={someStateThatStartsEmpty}>`, an `isConfirmationMatch("", "")` returning true would auto-arm the dialog before the parent's state hydrates. We force `expected.length > 0` instead. Test #11 in the helper suite pins this.
- **The success state offers no "Reload" button.** Spec §3 originally proposed one. Decision in implementation: the parent owns `onSuccess`, so a future T10 will wire `useMutation()` and call `queryClient.invalidateQueries(['tasks', id])` + `router.refresh()` on `onSuccess`. Adding a manual Reload button now would be a UI-only stub that T10 strips in 2 days — defer.
- **`/tasks/[id]` page bundle is 3.4 kB** (was 1.7 kB pre-T11). Of that delta, ~1.4 kB is `<DangerConfirm>` (Tailwind class strings dominate; the logic is ~50 LOC) and ~0.3 kB is `<KillTaskButton>`. The dialog + button live in the same chunk because `kill-task-button.tsx` directly imports `danger-confirm.tsx`. Acceptable.
- **No regression in T03 kill-router tests.** The 22-test integration suite for the server procedure was untouched. The only call site that changed is the *page* — and the page uses `<KillTaskButton>` which uses `tasks.kill` over the same wire format the integration tests already cover.

## Acceptance criteria status

| Criterion | Status |
|-----------|--------|
| 1. Pure helpers — URL, request builder, match-guard | ✅ |
| 2. View — all state matrix props rendered correctly | ✅ |
| 3. Wrapper — interactive state + cookie read + onSubmit seam | ✅ |
| 4. Kill button — render policy + DangerConfirm wiring | ✅ |
| 5. Page wiring — `app/tasks/[id]/page.tsx` adds the button | ✅ |
| 6. No mutation bypass — server-side T03/T07/T08/T04 still gate | ✅ |
| 7. No regression — full bun test green, tsc clean, build clean | ✅ |
