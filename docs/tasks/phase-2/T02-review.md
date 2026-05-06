# P2-T02 — review

## What landed

**New files (5):**

| File | Purpose | Lines |
|------|---------|------:|
| `src/lib/dispatch-client.ts` | Pure browser helpers — cookie parser, RequestInit assembly, tRPC envelope unwrap, `DispatchError`. | 122 |
| `src/components/dispatch-dialog.tsx` | `DispatchDialogView` (pure markup) + `DispatchDialog` (`"use client"` wrapper with state + ⌘K listener + lazy agents fetch + submit fetch). | 290 |
| `src/components/dispatch-trigger.tsx` | Topbar button — dispatches `bridge:open-dispatch` custom event; pairs with the global ⌘K hotkey on a single open-state authority. | 26 |
| `tests/lib/dispatch-client.test.ts` | 16 pure-helper tests — cookie parse, RequestInit shape, success / error envelope unwrap. | 167 |
| `tests/app/dispatch-dialog.test.ts` | 9 view-only markup tests — closed / loading / idle / submitting / success / error / no-agents / csrf-missing / empty-prompt. | 144 |
| `docs/tasks/phase-2/T02-dispatch-dialog.md` | TDD spec + acceptance + risk mitigation. | 175 |

**Modified files (1):**

| File | Change |
|------|--------|
| `src/components/topbar.tsx` | Mount `<DispatchTrigger>` next to the theme toggle and the singleton `<DispatchDialog>` so the modal hosts inside the topbar wrapper. Both only mount inside the authed shell — same pathway as the theme toggle. |

**Test count:** +25 (458 total bun-test green; 2988 expects). Typecheck clean. `bun run build` clean (no warnings; 9 pages generated). Pre-existing one-off audit-test stderr line ("would-be SQLITE_BUSY") and the mcp-pool mock crash logs are unchanged from prior iterations.

## Self-review checklist

- [x] **Tests cover happy + error path.** 25 tests:
  - 6 cookie parser cases (multi-cookie, missing, prefix collision, whitespace, repeated, null/undefined).
  - 3 `buildDispatchRequest` cases (URL + headers, omit-model, with-model).
  - 1 `buildAgentsListRequest` case (GET, no body, no CSRF header).
  - 5 `parseTrpcResponse` cases (data, json-wrapped data, error envelope, missing data falls back, malformed envelope).
  - 1 `DispatchError` shape.
  - 9 view-only markup states (closed, loading, idle-with-options, submitting, success-task-link, error-with-code, no-agents, csrf-missing, empty-prompt-disable).
- [x] **Mutation has audit log entry.** Inherited from T01 — the dialog's `submit` calls `tasks.dispatch` which writes the audit row server-side. The dialog itself does not need to (and must not) duplicate audit writes; the wire path is the single source of truth.
- [x] **CSRF token check.** Client reads `bridge_csrf_token` from `document.cookie` (non-HttpOnly per ADR 0001) and sets `x-csrf-token` on every dispatch POST. When the cookie is absent the dialog disables submit and shows a session-expired hint instead of silently 403'ing. `buildDispatchRequest` requires the token as an argument so the wire-shape is enforced at the type level.
- [x] **Rate limit applied.** Inherited from `rateLimitMutations` at `/api/trpc/[trpc]` — the dialog's POST goes through the same guard. On 429 the typed `TOO_MANY_REQUESTS` propagates through `parseTrpcResponse → DispatchError` and the dialog shows the code + message.
- [x] **Optimistic update + rollback.** Out of scope for T02 — explicitly deferred to T10. The dialog is server-confirmed: status flips `submitting → success` only after `parseTrpcResponse` returns a valid `taskId`.
- [x] **Confirmation pattern for destructive action.** Dispatch is *constructive*. T11 confirmation pattern is for kill / cancel-loop only.
- [x] **No secret leak.** The CSRF cookie is read by client JS as designed (ADR 0001). The dialog does not log prompt content. The audit row written server-side excludes the prompt (T01 spec). Error messages from the daemon are surfaced verbatim — same as Telegram replies and the existing tasks-detail error column.
- [x] **Typed error codes for the user.** `DispatchError.code` is whatever the server set in `error.data.code` — `BAD_REQUEST` / `TIMEOUT` / `TOO_MANY_REQUESTS` / `INTERNAL_SERVER_ERROR` / `CLIENT_CLOSED_REQUEST`. The view renders the literal code in `<span class="font-mono font-semibold">` so the user can copy/paste into a bug report; the human message follows.
- [x] **Pure helpers + pure view.** No DOM imports in `dispatch-client.ts`; tests run with plain `bun test`. The view component has zero hooks and zero event listeners — every state value is a prop. The wrapper component owns all imperative behaviour in one place.
- [x] **⌘K hotkey precondition.** Listener guards `e.metaKey || e.ctrlKey` and excludes `shift/alt`. `e.preventDefault()` runs only on a clean ⌘K so the browser's quick-search shortcut is replaced. Typing `k` alone (e.g. into the prompt textarea) is unaffected.
- [x] **Cleanup on unmount.** `useEffect` returns `() => removeEventListener(...)` for both `keydown` and `bridge:open-dispatch`. The agents cache lives on a module-level object (`AGENTS_CACHE`) so re-mounts don't refetch — but a test-only `__resetDispatchAgentsCache()` is exported for Playwright / future jsdom tests.
- [x] **Agent list fallback when daemon offline.** `ensureAgents` catches the `parseTrpcResponse` throw, sets `status="error"` + populates `errorCode/errorMessage`. The dialog still opens — the user can dismiss without entering a stuck state.

## Risk delta vs spec

The T02 spec listed 6 risks (all **Low** in the review matrix). All mitigations landed as specified, with two concrete observations:

- **Tailwind `disabled:` utility classes contained the substring `disabled` in static markup**, breaking my initial assertion `not.toContain("disabled")`. Switched to `match(/\sdisabled(=|>|\s)/)` which matches the HTML attribute form precisely. Spec didn't anticipate this — leaving a comment in the test for future readers.
- **`react-dom/server`'s `renderToStaticMarkup` works on a function call, not JSX**, since the bun test config does not transform `.tsx` test files. Tests therefore call `DispatchDialogView(props)` to get the React element first, then pass it to `renderToStaticMarkup`. Matches the existing test in `tests/app/agent-detail-memory.test.ts` which calls a page module's default export the same way.

## Browser-test plan (deferred to step 14 phase sweep)

Manual flow when the daemon ships `bridge mcp` (today the dispatch will fail-fast as `MCP_SPAWN_FAILED → INTERNAL_SERVER_ERROR`):

1. Open `/agents` while authed. Press ⌘K. Expect the dialog to open and the agents list to populate within ~100 ms.
2. Verify the topbar `Dispatch ⌘K` button opens the same dialog from any page (`/cost`, `/tasks`, `/agents/<name>`).
3. Type a prompt. Click Dispatch. Expect a `Task #N` link to render and the dispatched task to appear at the top of `/tasks`.
4. Click the link. Expect navigation to `/tasks/[id]` with the matching task detail.
5. Try Dispatch with no CSRF cookie (delete it via DevTools). Expect the submit button to disable + the session-expired banner to show.
6. Try Dispatch with `JWT_SECRET` unset on the server. Expect a 403 → `INTERNAL_SERVER_ERROR` toast in the dialog (CSRF guard returns 403 before the procedure runs; `parseTrpcResponse` doesn't recognise that envelope and falls back to `INTERNAL_SERVER_ERROR`).

Step 14 (PHASE-BROWSER-TEST.md) will fold these into the consolidated 12-step manual matrix.

## Files touched

```
A  docs/tasks/phase-2/T02-dispatch-dialog.md     (+175)
A  docs/tasks/phase-2/T02-review.md              (this file)
A  src/components/dispatch-dialog.tsx            (+290)
A  src/components/dispatch-trigger.tsx           (+26)
A  src/lib/dispatch-client.ts                    (+122)
A  tests/app/dispatch-dialog.test.ts             (+144)
A  tests/lib/dispatch-client.test.ts             (+167)
M  src/components/topbar.tsx                     (+5 -0)
```
