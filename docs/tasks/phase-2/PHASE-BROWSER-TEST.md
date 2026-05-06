# Phase 2 — Browser Test Plan (Manual)

> **Why manual:** Playwright (`tests/e2e/*.spec.ts`) covers the contract
> — CSRF rejected without header, rate-limit returns 429 after 30
> mutations, dispatch dialog mounts and submits, audit-view filters
> URL-as-truth — but it cannot replicate the *experience* of clicking
> Allow on a permission toast that arrives via SSE, watching a kill
> roll back when the daemon refuses, or feeling the ⌘K modal pop
> instantly on a stale page. This plan is the human gate before
> Phase 2 ships.
>
> **Pre-req:** identical to Phase 1 — `bridge.db` reachable via
> `discoverBridgeDaemon()` (`~/.claude-bridge/config.json` populated,
> daemon running, ≥ 1 agent, ≥ 1 running task or pending permission for
> the live-update steps). Phase 2 additionally requires the daemon's
> `bridge mcp-stdio` subcommand to be functional — `T12` assumes
> long-lived stdio framing.

---

## Setup (run once)

```sh
cd /Users/hieutran/projects/bridge-bot-ts-1/claude-bridge-dashboard
bun install                               # if cold
DASHBOARD_PASSWORD=test bun dev           # boots on :3000
# In another shell, leave the dev server logs visible to spot
# rate-limit / CSRF / audit warnings.
# In a third shell, keep `bridge` CLI handy for the live-update
# permission relay step (Step 9).
```

Open http://localhost:3000 — middleware should redirect to `/login`.
Log in with `test`. From here every step assumes you stay logged in
(JWT cookie, 7-day exp).

---

## Steps

### Step 1 — Dispatch via ⌘K (T02 + T01)

- Action: from `/agents`, press `⌘K` (or click the "Dispatch" header
  button). Pick an agent, type a 1-line prompt, submit.
- Expected: dialog mounts in < 100 ms, agent selector shows the same
  list as `/agents`, prompt textarea auto-focuses. On submit, dialog
  closes, a toast appears with a link "View task" → `/tasks/<id>`.
  The new task's status is `running` and the row shows on `/tasks`
  with no full-page reload.
- DevTools check: Network tab — exactly one `POST /api/trpc/tasks.dispatch`
  with `x-csrf-token` header, response 200, JSON body `{ result: {
  data: { taskId: "..." } } }`.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 2 — Kill a running task (T03 + T11 + T10)

- Action: pick a task with status `running` (dispatch one in Step 1
  first if the daemon has nothing live), open `/tasks/<id>`, click
  the **Kill task** button.
- Expected: `<DangerConfirm>` modal opens; the action button stays
  *disabled* until you type the task-id prefix (or agent name) into
  the input. Cancel works (Esc + button). Confirm → button shows
  spinner; the task row's status flips to `killed` *optimistically*
  (T10) within ~200 ms; the real status arrives via SSE within ~2 s
  and matches.
- Negative variant: kill a task that already `done`. Confirm. Expected:
  the API returns ok with a warning (idempotent); no error toast,
  status stays `done`.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 3 — Optimistic rollback (T10)

- Action: with DevTools Network throttled to "Offline", repeat Step 2
  on a different running task. Click confirm in `<DangerConfirm>`.
- Expected: status flips to `killed` immediately (optimistic), then
  *reverts* to `running` within ~5 s when the request fails. An
  error toast surfaces ("kill failed — retry?"). The dispatch dialog
  preserves the prompt text on similar failure (Step 1 with offline
  throttle) — no lost typing.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 4 — Loop approve / reject (T06)

- Action: trigger a goal loop with `manual` done condition from CLI
  (`bridge loop --agent <a> --goal <g> --done-when manual:`), wait
  for it to enter `pending_approval`, then open the corresponding
  `/tasks/<id>` page in the dashboard.
- Expected: an inline panel renders **Approve** / **Reject** buttons
  with a reason textarea. Click Reject with a 1-line reason — page
  re-renders server-confirmed (no optimistic flip), loop status moves
  to `iterating` (next iter) within ~2 s. Click Approve from a
  different pending iter — loop status terminates within ~2 s.
- Race check: with the same loop, click Approve in the dashboard *and*
  send `/loop_approve` from Telegram in the same second. Expected:
  one wins, the other gets a clear "already resolved" toast, neither
  errors out.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 5 — Audit log viewer (T05)

- Action: nav → `/audit`. Filter by `action=task.dispatch`, then by
  `user_id=<your id>`, then by `since=<5 min ago>`.
- Expected: virtualized table renders rows in chronological order,
  newest first. Each filter mutates URL (`/audit?action=task.dispatch`)
  and re-renders without flash. Clicking a row expands the
  `payload_json` (formatted, syntax-highlighted). The dispatched
  task from Step 1 should appear; the kill from Step 2 should appear
  with `action=task.kill`. The `request_id` column is non-empty.
- Scroll check: scroll to row 1000+ — frame rate stays smooth (the
  virtualizer keeps DOM ≤ ~50 rows).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 6 — CSRF guard (T08)

- Action: in DevTools console:
  ```js
  fetch('/api/trpc/tasks.kill?batch=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ "0": { json: { id: "fake" } } })
  }).then(r => console.log(r.status));
  ```
  (deliberately omitting `x-csrf-token`).
- Expected: response **403**. Network tab shows the request never
  reached the tRPC handler (no audit row written either — confirm
  on `/audit`). With the header added back (`'x-csrf-token':
  document.cookie.split('csrfToken=')[1].split(';')[0]`) the same
  request returns 200 (or a tRPC error from the daemon, which is
  fine — the *guard* passed).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 7 — Rate-limit (T07)

- Action: in DevTools console, fire 32 dispatches in a tight loop:
  ```js
  for (let i = 0; i < 32; i++) {
    await fetch('/api/trpc/tasks.dispatch?batch=1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': document.cookie.match(/csrfToken=([^;]+)/)[1],
      },
      body: JSON.stringify({ "0": { json: { agent: "non-existent",
        prompt: "rate-limit-test "+i } } })
    });
  }
  ```
- Expected: requests 1..30 return 200/4xx (the daemon may reject the
  fake agent — that's fine, the bucket counts attempts). Requests
  31..32 return **429** with `Retry-After: <seconds>` header. An
  audit row `rate_limit_blocked` is written for the rejected
  attempts (visible on `/audit`).
- Pre-auth variant: log out, then attempt 6 logins with wrong password
  in 1 minute. Expected: attempt 6 returns 429.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 8 — ⌘K dispatch dialog UX polish (T02)

- Action: from any page, press `⌘K` (macOS) / `Ctrl-K` (other).
- Expected: dialog opens, agent combobox is keyboard-navigable
  (`↓`/`↑`/`Enter`), Esc closes the dialog without state side-effects
  (no half-submitted dispatch), focus returns to the trigger element.
  Re-open: previous prompt text is **not** retained (intentional —
  T02 doesn't persist drafts across opens; T10 only preserves on
  *failure* mid-submit).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 9 — Permission relay toast (T09)

- Action: from CLI, dispatch a task that triggers a tool requiring
  permission (e.g. `bridge dispatch --agent <a> "ls /tmp"` if the
  agent's MCP config holds `Bash` in the prompt-on-use list). Keep
  the dashboard tab focused.
- Expected: within ~2 s of the daemon hooking on the tool call, a
  toast slides in from bottom-right. It shows the tool name
  (`Bash`), command (truncated to 200 chars if long), and **Allow** /
  **Deny** buttons. Click Allow.
- Verify: the daemon's hook returns within ~2 s; the toast disappears
  with a fade; an audit row `permission.respond` appears on `/audit`
  with `payload.decision = "approved"` and **no `command` field**
  (privacy invariant). Repeat with Deny on a fresh permission — same
  flow, payload `decision = "denied"`.
- Multi-tab check: open the same dashboard URL in tab B. Trigger a
  permission. Both tabs show the toast. Click Allow in tab A. Tab B's
  toast disappears within ~2 s (driven by the SSE `resolved` event,
  no cross-tab coordination).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 10 — Confirmation pattern keystroke guard (T11)

- Action: open the kill confirmation modal from Step 2 (re-dispatch a
  task first if needed). With the modal open, try to click the
  **Kill** button without typing anything.
- Expected: button is disabled (greyed out, `aria-disabled="true"`).
  Type a *wrong* prefix (e.g. one character off the task id) —
  button stays disabled. Type the correct prefix — button enables;
  the input flashes a brief green confirmation. Esc closes the
  modal; the input clears.
- Same flow on `/tasks/<id>` Reject loop (Step 4) — typed-name guard
  is **not** required there (rejection is recoverable; only kill is
  destructive enough to gate). Confirm: Reject is one click + reason.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 11 — Audit filter URL-as-truth + virtualized scroll (T05)

- Action: copy the URL `/audit?action=task.dispatch&since=2026-05-06`
  into a new tab.
- Expected: filters auto-populate from query params; the table
  renders only matching rows. Edit a filter via the form — URL
  updates without full reload (Next.js shallow nav). Hit back-button
  — previous filter set restored.
- Virtualization stress: clear all filters, scroll to bottom of the
  table (should reach the oldest row in the daemon's audit history).
  Frame rate stays > 50 fps. DevTools "Elements" panel: only ~40-60
  `<tr>` nodes in DOM at any time, regardless of total row count.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 12 — Audit covers every Phase 2 mutation

- Action: nav → `/audit`, clear all filters, sort by `created_at desc`.
- Expected: the audit log contains rows for every action you
  performed in steps 1..10:
  - `task.dispatch` × N (Step 1, 7, 8)
  - `task.kill` × N (Step 2, 3)
  - `loop.approve` / `loop.reject` (Step 4)
  - `permission.respond` × 2 (Step 9, both decisions)
  - `rate_limit_blocked` (Step 7)
  - `csrf.rejected` *or* the equivalent guard-side audit (Step 6 —
    note: T08's spec is for the guard to **deny silently**; an audit
    row is *optional* per ARCH §10. Acceptable if missing.)
  Each row carries `request_id`, `user_id`, `ip_hash` (hex), and a
  `payload_json` with the action's input shape.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

---

## Cross-cutting checks

- [ ] **Theme toggle** — switch dark ↔ light at any point during the
  flow. No FOUC, no console error, the dispatch dialog and audit
  table both re-theme cleanly.
- [ ] **DevTools Console** — zero errors, zero React-19 hydration
  warnings on every route + every dialog. (One known-noisy line is
  the EventSource reconnect log — that's expected and bounded.)
- [ ] **DevTools Network** — every mutation request carries
  `x-csrf-token`; no `x-csrf-token` ever appears on a `GET`. Every
  successful mutation has a corresponding audit row within 1 s.
- [ ] **Logout + replay** — log out, then re-paste the URL from any
  audit-filter step. Expect redirect → `/login`. Log back in, audit
  filter URL still works (URL-as-truth is auth-orthogonal).

---

## Playwright E2E summary (`bun run test:e2e`)

`tests/e2e/` ships 5 specs covering the contract — they are the
machine-readable counterpart to the human steps above:

| Spec | Asserts |
|------|---------|
| `smoke.spec.ts` | Phase 1 baseline: login → agents → tasks → task detail (carried forward, **1 known fail** — see test results §). |
| `dispatch-dialog.spec.ts` | ⌘K opens dialog, dispatch mutation fires, toast renders link. |
| `csrf.spec.ts` | POST `/api/trpc/*` without `x-csrf-token` returns 403; with valid token passes guard. |
| `rate-limit.spec.ts` | 30 mutations within 60 s succeed; 31st returns 429 with `Retry-After`. |
| `audit-view.spec.ts` | `/audit` URL-as-truth filters round-trip; virtualizer keeps DOM bounded at row 500. |

Run via `bun run test:e2e`. The single Phase 1 carry-over fail
(`smoke.spec.ts` calling Playwright `test()` under `bun test`) is
documented in `T13-review.md` (Phase 1) and is **not introduced by
Phase 2** — `bun run test` (scoped) stays clean.

---

## Sign-off

- Tester: _______________________________________
- Date: _________________________________________
- Browser / version: ____________________________
- Daemon version: _______________________________
- Overall: [ ] PASS / [ ] FAIL / [ ] PASS-WITH-NOTES

> If any step fails, file it under "Phase 3 entry blockers" before
> starting Phase 3 work. The Phase 2 mutation surface is the
> foundation for every subsequent phase — a CSRF or audit gap here
> compounds.
