# P2-T11 — Confirmation pattern

> Reusable confirmation primitive for destructive mutations. The
> dashboard fires destructive mutations from the browser (`tasks.kill`,
> later `loops.cancel`); a slip-of-the-thumb on a phone or a
> mis-clicked row should not trigger a `bridge_kill` against the wrong
> agent. T11 ships a `<DangerConfirmView>` (pure markup) +
> `<DangerConfirm>` (interactive wrapper) requiring the user to type a
> short confirmation token (the agent name for `kill`, the loop id
> for `loops.cancel`) before the action button enables.
>
> The component is shipped *unwired* into a "kill task" UI — the
> task-detail page (`/tasks/[id]`) gets a real Kill button that opens
> the confirmation, types-to-arm, then issues `tasks.kill`. T03 already
> shipped the server procedure; this task wires the UI side.

## References

- v2 IMPLEMENTATION-PLAN P2-T11 — *"shadcn `<AlertDialog>` for
  destructive actions (kill, cancel loop). Typing the agent name (or
  task ID prefix) to enable the action button. Reusable
  `<DangerConfirm name=… verb=…>` primitive used by T03 + T06."*
- v1 ARCH §10 — every destructive mutation writes to `audit_log`
  (already covered server-side by T01/T03/T06; the UI must not bypass
  the server's audit step — which it can't, the audit is on the tRPC
  procedure).
- T03 spec (`docs/tasks/phase-2/T03-kill.md`) — the kill server
  procedure shape `tasks.kill({ id })` returning
  `{ ok: true, alreadyTerminated: boolean }`.
- T02 spec (`docs/tasks/phase-2/T02-dispatch-dialog.md`) — the
  view/wrapper split pattern this task copies (pure helpers + pure
  view + `"use client"` wrapper, view-tested via
  `renderToStaticMarkup`).
- INDEX (this phase) §"Iteration mapping" — slot 11. *"UX guard;
  reused retroactively in T03 + T06."*
- `docs/PHASE-2-REVIEW.md` §c risk table — T11 = **Low**.

## Scope

- New pure helper module `src/lib/danger-confirm-client.ts`:
  - `KILL_TASK_URL` constant (`/api/trpc/tasks.kill`).
  - `KillTaskInput`, `KillTaskResult` wire types (mirror server's
    `KillResult`).
  - `buildKillTaskRequest({ id }, csrfToken)` → `{ url, init }` for
    `fetch`. Same wire-format as `buildDispatchRequest` in T02.
  - `isConfirmationMatch(input, expected)` → boolean; case-sensitive
    exact match after `.trim()`. Empty `expected` → never matches
    (prevents accidental "blank confirmation" passes).
  - Re-exports `parseTrpcResponse`, `readCsrfTokenFromCookie`,
    `DispatchError` from `dispatch-client.ts` so the kill button uses
    one toolbox.
- New view component `src/components/danger-confirm.tsx`:
  - `DangerConfirmView` — pure props-driven markup. No hooks, no
    `document` access, no listeners. Tested via
    `renderToStaticMarkup`.
  - `DangerConfirm` — `"use client"` wrapper that owns state
    (`open`, `typed`, `status`, `errorCode`, `errorMessage`,
    `csrfMissing`) + the submit fetch. Reuses
    `readCsrfTokenFromCookie` once in `openDialog`.
  - Surfaces a slot pattern: parent owns the *trigger* button (so the
    Kill button on `/tasks/[id]` looks the same as later Cancel
    buttons on `/loops/[id]`), parent passes the bind-once
    `expectedConfirmation`, `verb` ("Kill", "Cancel"), `subject`
    ("task #42 on agent alpha"), and `onSubmit` (a function returning
    a Promise that performs the mutation; the component awaits it
    and turns the result into `success` / `error`).
- New thin wrapper `src/components/kill-task-button.tsx`:
  - `"use client"` component used by `/tasks/[id]`. Accepts
    `taskId`, `agentName`, `status` props. Renders the Kill button
    only when the task is in a non-terminal status; clicking it
    opens a `<DangerConfirm verb="Kill"
    expectedConfirmation={agentName} …>` whose `onSubmit` calls
    `buildKillTaskRequest` → `fetch` → `parseTrpcResponse`.
  - On success, the component shows a "killed" message + a "Reload"
    button (no SWR / RQ wired yet — T10 lands optimistic + cache
    invalidation; T11 ships the naked happy path).
- Wire the button into `app/tasks/[id]/page.tsx` next to the status
  badge in the header. The button must render server-side even
  though it's a client component (the parent page is a server
  component; mounting `"use client"` children is fine — Phase 1
  already does this for `<DispatchTrigger>` in `topbar.tsx`).

## Non-goals

- Optimistic UI update on kill — that's **T10**. After confirming,
  this task only *fires* the mutation and shows a success/error
  state. The page does not optimistically flip the badge; the user
  is invited to reload via a button.
- Wiring `<DangerConfirm>` to `loops.cancel` — Phase 2 INDEX lists
  loops.cancel as out-of-scope (we ship `loops.approve` /
  `loops.reject` only; cancel is the loop *runner*'s primitive, not
  a per-iteration mutation). The primitive is *ready* for Phase 3 to
  reuse but we don't add a second consumer in this task.
- Toast / portal infrastructure — the dialog renders in-place
  (fixed-position overlay over the page), same as `<DispatchDialog>`.
  No `react-hot-toast` dep added.
- React Query mutation hooks — T10 wires those; T11 uses raw `fetch`
  (the wire format is single-sourced via the helper module so T10
  can swap the call site to RQ without changing the dialog).

## Acceptance criteria

1. **Pure helpers — `src/lib/danger-confirm-client.ts`.**
   - `KILL_TASK_URL === "/api/trpc/tasks.kill"`.
   - `buildKillTaskRequest({ id: 42 }, "csrf-x")` returns
     `{ url: KILL_TASK_URL, init: { method: "POST", headers:
     { "content-type": "application/json", "x-csrf-token": "csrf-x" },
     body: JSON.stringify({ json: { id: 42 } }) } }`.
   - `isConfirmationMatch("alpha", "alpha")` → true.
   - `isConfirmationMatch(" alpha ", "alpha")` → true (trim).
   - `isConfirmationMatch("Alpha", "alpha")` → false (case-sensitive).
   - `isConfirmationMatch("", "")` → false.
   - `isConfirmationMatch("", "alpha")` → false.
   - `isConfirmationMatch("alpha", "")` → false.
   - `isConfirmationMatch("alpha\n", "alpha")` → true (trim).
   - The helper does **not** import React, the DOM, or `document`.
2. **View — `<DangerConfirmView>` (pure props).**
   - Renders nothing observable (no `role="dialog"`) when `open=false`.
   - When `open=true`, renders a heading containing the verb (e.g.
     `"Kill task #42"`), a subject line, and an input where the user
     types the expected confirmation.
   - The action button (text = verb) is **disabled** when the typed
     value does not match `expectedConfirmation`.
   - The action button is **enabled** when the typed value matches.
   - The action button is **disabled** while `status === "submitting"`,
     regardless of typed match.
   - The action button is **disabled** when `csrfMissing === true`,
     and a "session expired" hint renders.
   - On `status === "success"`, renders the success copy
     (`"Killed."` + the result `alreadyTerminated` flag) and a
     "Close" button instead of the form.
   - On `status === "error"`, renders the typed error code +
     message (same shape as `<DispatchDialogView>`).
3. **Wrapper — `<DangerConfirm>` (interactive).**
   - Mount at any open trigger; clicking the trigger opens the
     dialog and reads `document.cookie` once for `csrfMissing`.
   - Calls the `onSubmit` prop with the typed value when the action
     button is clicked. The prop returns a promise; the component
     awaits and turns the result into `status`.
   - The component **does not** know about `tasks.kill` directly —
     `onSubmit` is the seam. The kill-button consumer wires
     `buildKillTaskRequest` + `fetch` inside its `onSubmit`.
4. **Kill button — `<KillTaskButton>`.**
   - Renders nothing when `status` is `done | failed | killed`
     (terminal — no kill needed; matches the server's
     `TERMINAL_STATUSES`).
   - Renders a Kill button when status is `running | pending |
     queued` (or null/unknown — defensive: a status the dashboard
     doesn't recognise still gets a Kill button so the user can
     escape).
   - Trigger opens a `<DangerConfirm>` with
     `expectedConfirmation === agentName`,
     `verb === "Kill"`,
     `subject === "task #${taskId} on agent ${agentName}"`.
   - On success, the Kill button is replaced with a "Killed —
     reload page" link.
5. **Page wiring — `app/tasks/[id]/page.tsx`.**
   - Imports `<KillTaskButton>` and renders it inside `TaskHeader`
     to the right of the status badge.
   - Server-component-friendly: the import is a default import of a
     `"use client"` file; the parent page does not become a client
     component.
   - When `task.agentName === null` (orphan task), the button does
     **not** render (no agent → no `bridge_kill` target).
6. **No mutation bypass.** The dialog ultimately calls the same
   `tasks.kill` POST that exists from T03; CSRF + rate-limit + audit
   all flow through the procedure. The component does not read the
   DB, does not call the daemon directly, does not write
   `audit_log`. This is *purely* a UX guard.
7. **No regression.** The full `bun test` suite stays green (the
   T03 kill-router tests do not change; T05 audit-router tests do
   not change). `bun run typecheck` clean. `bun run build` clean.

## TDD plan (RED → GREEN)

### File 1: `tests/lib/danger-confirm-client.test.ts`

Pure helper tests. Mirror `tests/lib/dispatch-client.test.ts`:

1. `KILL_TASK_URL` value.
2. `buildKillTaskRequest` URL + method.
3. `buildKillTaskRequest` content-type header.
4. `buildKillTaskRequest` `x-csrf-token` header value.
5. `buildKillTaskRequest` body wrapping (`{json: {id}}`) — JSON-decoded.
6. `buildKillTaskRequest` does not include `model` / unrelated keys.
7. `isConfirmationMatch` exact match.
8. `isConfirmationMatch` trims input.
9. `isConfirmationMatch` is case-sensitive.
10. `isConfirmationMatch` empty input → false.
11. `isConfirmationMatch` empty expected → false (defence).
12. `isConfirmationMatch` whitespace-only input → false.
13. `isConfirmationMatch` newline at end → trims and matches.
14. Helper does not depend on `document` (smoke: import in plain bun
    test does not throw — covered by the file simply running).

### File 2: `tests/app/danger-confirm.test.ts`

`<DangerConfirmView>` view-only markup tests. Mirror
`tests/app/dispatch-dialog.test.ts`:

1. `open=false` → no `role="dialog"` and no verb/subject text.
2. `open=true, idle` → role=dialog, verb in heading, subject visible,
   confirmation input present, action button disabled (typed empty).
3. Type matches → action button enabled.
4. Type does not match → action button disabled.
5. Type matches but `status=submitting` → action button disabled.
6. `csrfMissing=true` → action button disabled, session-expired hint
   visible.
7. `status=success` → success copy + Close button; form gone.
8. `status=success, alreadyTerminated=true` → success copy mentions
   "already terminated" so the user knows the daemon didn't kill
   anything new.
9. `status=error` → error code + message rendered; form remains so
   user can retry.
10. Cancel button is always present in the form variant.

(Total: ~10 view tests.)

### File 3: `tests/app/kill-task-button.test.ts`

`<KillTaskButton>` view-only smoke tests via
`renderToStaticMarkup`. The component is a thin client wrapper, but
its render output is deterministic when no events fire — the initial
markup pre-hydration is what we assert.

1. `status="done"` → component renders nothing (no Kill markup).
2. `status="failed"` → no Kill markup.
3. `status="killed"` → no Kill markup.
4. `status="running"` → renders Kill button.
5. `status="pending"` → renders Kill button.
6. `status="queued"` → renders Kill button.
7. `status="unknown_x"` → renders Kill button (defensive).
8. `agentName === null` → renders nothing.
9. `status="running", agentName="alpha"` → trigger button label is
   `"Kill"` and points at the dialog (i.e. the rendered HTML
   contains both the trigger and the dialog markup; the dialog is
   `open=false` initially so its content is not visible).

(Total: ~9 smoke tests.)

## Implementation outline

### `src/lib/danger-confirm-client.ts`

```ts
import { CSRF_HEADER } from "./csrf";
import {
  parseTrpcResponse,
  readCsrfTokenFromCookie,
  DispatchError,
} from "./dispatch-client";

export const KILL_TASK_URL = "/api/trpc/tasks.kill";

export interface KillTaskInput { id: number; }
export interface KillTaskResult {
  ok: true;
  alreadyTerminated: boolean;
}

export function buildKillTaskRequest(
  input: KillTaskInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return {
    url: KILL_TASK_URL,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify({ json: { id: input.id } }),
    },
  };
}

export function isConfirmationMatch(
  input: string,
  expected: string,
): boolean {
  const trimmed = input.trim();
  if (trimmed.length === 0 || expected.length === 0) return false;
  return trimmed === expected;
}

export { parseTrpcResponse, readCsrfTokenFromCookie, DispatchError };
```

### `src/components/danger-confirm.tsx`

Two named exports, mirroring T02:

- `DangerConfirmView(props)` — the pure markup.
- `DangerConfirm(props)` — the wrapper with state + cookie read.

The view's prop surface:

```ts
export interface DangerConfirmViewProps {
  open: boolean;
  status: "idle" | "submitting" | "success" | "error";
  verb: string;          // "Kill"
  subject: string;       // "task #42 on agent alpha"
  expectedConfirmation: string;  // "alpha"
  typed: string;
  alreadyTerminated: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  csrfMissing: boolean;
  onTypeChange?: (value: string) => void;
  onConfirm?: () => void;
  onClose?: () => void;
}
```

### `src/components/kill-task-button.tsx`

```tsx
"use client";

interface Props {
  taskId: number;
  agentName: string | null;
  status: string | null;
}

const TERMINAL = new Set(["done", "failed", "killed"]);

export function KillTaskButton({ taskId, agentName, status }: Props) {
  if (agentName === null) return null;
  if (status && TERMINAL.has(status)) return null;
  return (
    <DangerConfirm
      verb="Kill"
      subject={`task #${taskId} on agent ${agentName}`}
      expectedConfirmation={agentName}
      onSubmit={async () => {
        const csrf = readCsrfTokenFromCookie(document.cookie);
        if (csrf === null) throw new DispatchError("FORBIDDEN", "CSRF cookie missing");
        const { url, init } = buildKillTaskRequest({ id: taskId }, csrf);
        const res = await fetch(url, init);
        const json: unknown = await res.json();
        return parseTrpcResponse<KillTaskResult>(json);
      }}
    />
  );
}
```

### `app/tasks/[id]/page.tsx` — minimal patch

In `TaskHeader`, add the Kill button after the badge:

```tsx
import { KillTaskButton } from "@/src/components/kill-task-button";

<Badge variant={badge.variant}>{badge.label}</Badge>
<KillTaskButton
  taskId={task.id}
  agentName={task.agentName ?? null}
  status={task.status ?? null}
/>
```

## Risk + mitigation

| Risk (PHASE-2-REVIEW §c.T11) | Mitigation |
|------------------------------|------------|
| User mistypes confirmation token, mutation never fires → frustration | Match is case-sensitive but trimmed (handles trailing newline / accidental space). Subject line includes the agent name verbatim so the user can copy. |
| User intentionally bypasses the dialog (devtools, network tab) | The dialog is *UX*, not security. The server-side T03 kill is gated by CSRF (T08) + rate-limit (T07) + audit (T04). A devtools-savvy user can still hit `tasks.kill` — but every call audits. Documented. |
| `<DangerConfirm>` re-renders mid-typing → state lost | Wrapper owns `typed` in `useState`; the view is fully props-driven. No internal `key=` reset triggers. |
| Phase 4 RQ migration breaks the dialog | `onSubmit` is a generic `() => Promise<unknown>` seam. T10 swaps the kill button's `onSubmit` to call `useMutation().mutateAsync()` without touching the dialog. |
| Confirmation primitive is reused later for `loops.cancel` and the agent name shape doesn't fit | The prop is `expectedConfirmation: string` — caller picks (loop id, task id, agent name). T11 only ships the kill consumer; future consumers pass whatever they want. |
| Naked button with no optimistic update — user clicks Kill, sees "killed", reloads, status badge still says running because daemon lag | Documented in §"Non-goals" — T10 wires optimistic update + RQ invalidation. T11's success state explicitly invites a manual reload. |
| Component test using `renderToStaticMarkup` cannot exercise the typed→enabled flip | The flip is *pure* — view receives `typed` + `expectedConfirmation` as props. We render two snapshots (mismatched / matched) and assert disabled-attribute behaviour on the action button. The interactive `<DangerConfirm>` wrapper's keystroke handling is covered by the Phase 2 step 14 Playwright sweep. |
