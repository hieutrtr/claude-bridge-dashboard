# P2-T02 — Dispatch dialog UI (⌘K)

> First **client-side** mutation surface in Phase 2. Wraps the
> `tasks.dispatch` procedure landed in T01 with a global modal that the
> user can open from any route via `⌘K` (or `Ctrl+K` on Linux/Windows)
> or via a topbar button. On submit, the dialog calls the tRPC
> mutation, surfaces typed errors as inline messages, and on success
> shows a "Task #NNN" link to `/tasks/[id]`.

## References

- v2 IMPLEMENTATION-PLAN P2-T2 — *"Modal `<Dialog>` từ shadcn,
  trigger ⌘K + button on /agents. Combobox agent (autocomplete from
  `agents.list`), textarea prompt, model select dropdown, cost-estimate
  placeholder. Submit gọi `tasks.dispatch`, show toast linking to
  /tasks/[id]."*
- v1 ARCH §11 — TTI < 1.0 s for modal mount; perf budget assumes the
  agents list is already on the wire (no extra round-trip on open in
  the warm path).
- v1 ARCH §10 — every mutation must travel POST through the tRPC
  surface (T08 CSRF) and consume a token bucket (T07).
- T01 spec (`docs/tasks/phase-2/T01-dispatch.md`) — the procedure this
  dialog drives. Error code → toast mapping is defined there.
- T08 ADR (`docs/adr/0001-csrf-strategy.md`) — `bridge_csrf_token`
  cookie is **not HttpOnly** so client JS can read it for the
  `x-csrf-token` request header.
- `docs/PHASE-2-REVIEW.md` §c risk row T02 = **Low** (UI work; cost
  estimate is rough).

## Scope

- `src/lib/dispatch-client.ts` — pure browser helpers:
  - `readCsrfTokenFromCookie(cookieString) → string | null`
  - `buildDispatchRequest(input, csrfToken)` → `{ url, init }` for
    `POST /api/trpc/tasks.dispatch`
  - `buildAgentsListRequest()` → `{ url, init }` for
    `GET /api/trpc/agents.list`
  - `parseTrpcResponse<T>(json) → T` — extracts `result.data` from the
    tRPC v11 wire shape; throws `DispatchError` (`{ code, message }`)
    on the error envelope.
- `src/components/dispatch-dialog.tsx` — two named exports:
  - `DispatchDialogView` (pure markup, no state, no `"use client"`
    needed for the props-rendered surface so tests can drive it via
    `renderToStaticMarkup`).
  - `DispatchDialog` — `"use client"` wrapper that owns local state
    (open / agents-list / form fields / status), wires the ⌘K + custom
    event listeners, and calls the helpers above. Lazy-loads agents on
    first open; success state surfaces a `<Link>` to `/tasks/[taskId]`.
- `src/components/dispatch-trigger.tsx` — `"use client"` button that
  dispatches a `bridge:open-dispatch` custom event on `window`.
  Decoupled from the dialog so any page can mount the trigger without
  prop-drilling state.
- Mount the dialog + trigger in `Topbar` so they're available from
  every authed route — same pattern as the theme toggle.
- The keystroke handler is registered globally (window-level
  `keydown`); it stops propagation when the active element is a
  `<textarea>` already inside our own dialog so the user can type a
  literal `⌘K` into a prompt without re-opening it.

## Non-goals

- Cost estimate. The plan flags this as a **placeholder** for T02; the
  textarea shows a static "Cost preview unavailable in Phase 2" hint.
  Real cost preview belongs to a later phase that integrates with the
  daemon's per-model pricing.
- Optimistic UI. Submission shows an inline spinner; on success the
  dialog renders a "Task #NNN" link rather than mutating any cached
  query. Optimistic dispatch updates land in T10.
- Confirmation dialog. Dispatch is *constructive* (creates a task), not
  destructive — confirmation is only required for kill / cancel-loop
  per T11.
- Toast library. Phase 1 didn't ship a toast primitive and v2 plan does
  not require one for T02. The dialog renders the success / error
  states inline (the modal stays open until the user dismisses it),
  which keeps the surface tested without a global portal.
- Combobox / autocomplete agent picker. We render a plain `<select>`
  with the agents list. Combobox + filter is a UX upgrade tracked
  separately (review §d.6).
- Mobile keyboard chord (⌘K isn't a thing on touch); the topbar button
  remains the discoverable trigger on mobile widths.

## Acceptance criteria

1. **⌘K opens the dialog from any authed route.** A global window
   `keydown` listener triggers when `e.key === "k"` and
   `(e.metaKey || e.ctrlKey)` and the dialog isn't already open. The
   listener calls `e.preventDefault()` so the browser's quick-search
   shortcut is replaced.
2. **Topbar trigger button mounts on every authed page.** Clicking it
   dispatches `window.dispatchEvent(new CustomEvent("bridge:open-dispatch"))`;
   the dialog listens for that event and opens. Same pathway as ⌘K.
3. **Lazy agents fetch on first open.** First open issues `GET
   /api/trpc/agents.list`; subsequent opens within the same session
   reuse the cached list (acceptable per perf budget — agents change
   slowly). Loading state shows a "Loading agents…" placeholder; if
   the fetch fails the dialog still opens with an error banner so the
   user can dismiss.
4. **Submit calls `tasks.dispatch` over POST.** Body shape `{ json:
   {agentName, prompt, model?} }` (tRPC v11 wire format). Headers
   include `content-type: application/json` and `x-csrf-token` read
   from `document.cookie` (`bridge_csrf_token`). Missing CSRF cookie
   → submission button is *disabled* with a hint banner ("session
   expired, reload"); we do not silently 403.
5. **Success path shows the linked task id.** On HTTP 2xx with a valid
   `result.data.taskId`, the dialog enters status=`success` and
   renders `<Link href="/tasks/{taskId}">Task #{taskId}</Link>`. The
   submit button becomes a "Dismiss" / "Dispatch another" pair so the
   user can keep going.
6. **Error path renders the typed code.** `parseTrpcResponse` throws
   `DispatchError({code, message})` extracted from the tRPC error
   envelope. The dialog shows `code` (e.g. `TIMEOUT`,
   `TOO_MANY_REQUESTS`, `INTERNAL_SERVER_ERROR`,
   `CLIENT_CLOSED_REQUEST`, `BAD_REQUEST`) plus the human message
   inline. The submit button re-enables so the user can retry.
7. **Form validation mirrors the server.** `agentName` required;
   `prompt` 1–32 000 chars (matches the Zod schema in T01). Client-side
   the submit button is disabled until both are non-empty. We do not
   try to perfectly mirror the server (the server is the source of
   truth) — this is a UX gate, not a security gate.
8. **Pure-view component.** `DispatchDialogView` accepts every state
   piece via props and renders deterministic markup; it has no
   `useState` / `useEffect` / event listeners of its own. Tests render
   it with `react-dom/server`'s `renderToStaticMarkup` for each state
   matrix (closed, loading, idle, submitting, success, error).
9. **Pure helpers in `src/lib/dispatch-client.ts`.** No DOM imports —
   parses cookie string, builds RequestInit, parses JSON. Tests run
   in plain `bun test` with no jsdom.

## TDD plan

### `tests/lib/dispatch-client.test.ts` — pure helpers (~10 cases)

1. `readCsrfTokenFromCookie` returns the bridge token from a multi-cookie
   string.
2. `readCsrfTokenFromCookie` returns `null` when the cookie header is
   empty / missing the bridge cookie.
3. `readCsrfTokenFromCookie` ignores cookies that share a prefix with
   the bridge cookie name.
4. `buildDispatchRequest` produces `POST /api/trpc/tasks.dispatch` with
   `content-type: application/json` + `x-csrf-token` header.
5. `buildDispatchRequest` body is JSON `{ json: {agentName, prompt} }`
   when `model` omitted, and `{ json: {agentName, prompt, model} }`
   when included.
6. `buildAgentsListRequest` produces `GET /api/trpc/agents.list` with
   no body, no CSRF header (queries are exempt per T08 guard).
7. `parseTrpcResponse` returns `result.data` for the success envelope.
8. `parseTrpcResponse` throws `DispatchError` with `code` +
   `message` from the error envelope (`{error: {data: {code}, message}}`).
9. `parseTrpcResponse` throws a generic `INTERNAL_SERVER_ERROR` for
   malformed JSON (no `result` and no `error` keys).
10. `DispatchError` is an `Error` subclass with `.code` and
    `.message` populated.

### `tests/app/dispatch-dialog.test.ts` — view-only markup (~8 cases)

Drives `DispatchDialogView` via `renderToStaticMarkup`:

1. `open=false` → renders nothing observable (empty / no role=dialog).
2. `open=true, status="loading"` → "Loading agents…" copy is present;
   no `<select>` of agents yet.
3. `open=true, status="idle"` → renders the agent select with each
   agent name as an `<option>`, the prompt textarea, and the
   "Dispatch" button.
4. `open=true, status="submitting"` → submit button is `disabled`.
5. `open=true, status="success", completedTaskId=42` → renders
   `<a href="/tasks/42">Task #42</a>` with the success label.
6. `open=true, status="error", errorCode="TIMEOUT", errorMessage="..."`
   → renders both the code and message strings; submit button is
   re-enabled.
7. `open=true` with empty agents (post-load, daemon offline) → renders
   the "no agents available" hint instead of an empty `<select>`.
8. `open=true, csrfMissing=true` → submit disabled, hint banner about
   reloading the session.

## Risk + mitigation

(From `docs/PHASE-2-REVIEW.md` §c — T02 = **Low** risk; mitigations
remain useful given the new `⌘K` global hotkey and lazy-load agent
fetch surface.)

| Risk | Mitigation |
|------|------------|
| ⌘K conflicts with other shortcuts (browser quick-search). | `e.preventDefault()` only when the dialog isn't already open. Tests assert handler signature. |
| Agents list stale → user dispatches to a now-deleted agent. | Server returns the canonical error (`MCP_RPC_ERROR` → `INTERNAL_SERVER_ERROR` toast); no client-side caching beyond the modal's own session. |
| CSRF token cookie expired between page load and submit. | Submit disabled when cookie missing; hint asks user to reload. |
| Long prompt freezes browser on submit click. | `prompt` capped at 32 000 chars (matches server Zod). The dialog disables submit during the in-flight request so duplicate Enter keystrokes are ignored. |
| Hotkey active during agent name typing. | Listener guards against `metaKey/ctrlKey + k` only — typing `k` alone is fine. Tests assert this. |
| Open-modal in non-authed pages. | Trigger only mounts inside the `authed` branch of the layout (same as `<Topbar>`). |

## Notes

- `tests/app/dispatch-dialog.test.ts` is a `.ts` file (not `.tsx`)
  matching the rest of the repo's tests — they import the component
  module directly and call its function with a props object, then
  feed the resulting React element into `renderToStaticMarkup`. No
  JSX in tests, keeps the bun test runner config unchanged.
- The custom event name `bridge:open-dispatch` is namespaced so a
  later page can listen for the same event to pre-fill the dialog
  (e.g. an agent card "Dispatch to this agent" button could pass
  `{detail: {agentName}}` — already supported by the listener
  contract). Out of scope for T02 but the API allows it.
- `DispatchDialog` does **not** dismiss on `Escape` automatically —
  Phase 2 is the first interactive surface and we want the user to
  consciously close after a successful dispatch. Escape-to-close can
  land alongside T11 confirmation dialogs once the UX pattern is
  established.
