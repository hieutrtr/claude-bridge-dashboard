# Phase 3 — Browser Test Plan (Manual)

> **Why manual:** the Playwright suite (`tests/e2e/loop-flow.spec.ts`,
> `tests/e2e/schedules-flow.spec.ts`) drives the contract — start /
> cancel / approve flows, schedule create / pause / delete with typed-
> name confirm, CSRF + rate-limit headers, audit echo — but cannot
> replicate the *experience* of a cron picker recomputing fire times
> as you type, the cost forecast block flipping between
> "insufficient history" and a dollar range, the run-history drawer
> sliding in over `/schedules`, or the optimistic pause flip rolling
> back when the daemon refuses. This plan is the human gate before
> Phase 3 ships.
>
> **Pre-req (carried from Phase 2):** `bridge.db` reachable via
> `discoverBridgeDaemon()` (`~/.claude-bridge/config.json` populated,
> daemon running, ≥ 1 agent, ≥ 1 schedule history sample for the
> forecast step). Phase 3 additionally requires the daemon's
> `bridge_loop`, `bridge_loop_cancel`, `bridge_loop_approve`,
> `bridge_loop_reject`, `bridge_schedule_add`, `bridge_schedule_pause`,
> `bridge_schedule_resume`, `bridge_schedule_remove` MCP tools to be
> live on stdio (T12 pool reuses them as-is — no Phase 3 fork).

---

## Setup (run once)

```sh
cd /Users/hieutran/projects/bridge-bot-ts-1/claude-bridge-dashboard
bun install                               # if cold
DASHBOARD_PASSWORD=test bun dev           # boots on :3000
# In another shell, leave the dev server logs visible to spot
# rate-limit / CSRF / audit warnings.
# In a third shell, keep `bridge` CLI handy for the cross-channel
# race step (Step 4).
```

Open http://localhost:3000 — middleware should redirect to `/login`.
Log in with `test`. From here every step assumes you stay logged in
(JWT cookie, 7-day exp).

---

## Steps

### Step 1 — `/loops` list + filters (T1)

- Action: nav → `/loops`. Use the status filter pills at the top to
  switch between `running`, `waiting_approval`, `done`, `cancelled`,
  `failed`. Then filter by agent (dropdown reuses `agents.list`).
- Expected: each pill click mutates the URL
  (`/loops?status=running&agent=<name>`) and the table re-renders
  without a full reload (Next.js shallow nav). Columns visible:
  truncated `loop_id` (8-char prefix), `agent`, status badge,
  `current_iteration / max_iterations`, budget bar
  (`total_cost / max_cost`). Empty / loading / error states reuse
  the Phase 1 T11 primitives. Click a row → `/loops/[loopId]`.
- DevTools check: Network tab — exactly one
  `GET /api/trpc/loops.list` per filter change; no extra request on
  back-button (URL-as-truth round-trips).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 2 — Loop detail timeline + cost sparkline (T2)

- Action: from Step 1, click the longest-running loop. Expand 3 of
  the 5 most recent iterations.
- Expected: header card shows agent / goal / done_when / status /
  budget bar. Iteration timeline lists rows ascending by
  `iteration_num`; each iter expands inline (lazy — collapsed iters
  do not render their `result_summary`). Cumulative-cost sparkline
  (recharts) renders above the timeline and reflects only the
  iterations rendered so far. Each iter's "→ task" link goes to
  `/tasks/[taskId]` (Phase 1 T05 surface).
- Performance check: a 50-iter loop should render in < 200 ms
  (no virtualizer at this scale per T2 acceptance). Frame rate
  smooth on collapse / expand.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 3 — Start a new loop (T3)

- Action: from `/loops` press the **Start loop** button. Pick an
  agent, type a 1-line goal, choose `done_when` template `manual:`,
  leave `max_iterations` at default 10 and `max_cost_usd` blank.
  Submit.
- Expected: dialog mounts in < 100 ms, agent dropdown matches
  `/agents`. Submit closes the dialog and redirects to
  `/loops/[id]` within ~1 s. The new loop's status is `running`
  (or `iterating` once the daemon picks it up).
- Validation check: open the dialog again. Type goal `garbage`
  into `done_when` (no prefix). Submit button stays disabled —
  the regex
  `^(command|file_exists|file_contains|llm_judge|manual):.*` is
  enforced client-side. Switch to `command:test -f /tmp/x` —
  button enables.
- DevTools check: Network tab — exactly one
  `POST /api/trpc/loops.start` with `x-csrf-token` header,
  response 200, JSON body `{ result: { data: { loopId: "..." } } }`.
  `/audit` row `loop.start` appears within 1 s with payload
  `{ agent, doneWhen, maxIterations, ... }` — **goal text NOT
  echoed**, only `hasGoal: true` per the privacy precedent.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 4 — Cancel + approve / reject from `/loops/[id]` (T4)

- Action: from Step 3 (the `manual:` loop), wait for the daemon to
  reach the first iteration's pending-approval gate. The detail
  page should render large **Approve** / **Reject** buttons at the
  top of the detail card.
- Expected: clicking **Approve** calls `bridge_loop_approve` via
  MCP; the gate buttons disappear within ~2 s. Clicking **Reject**
  on a different pending iter pops a reason textarea — submit with
  a 1-line reason, gate clears, next iter starts. Audit rows
  `loop.approve` and `loop.reject` appear; reject's `payload` has
  `hasReason: true` (no reason text echoed).
- Cancel variant: open a `running` loop. Click the **Cancel loop**
  button (red). DangerConfirm modal opens — the action button
  stays disabled until you type the loop-id 8-char prefix. Type
  the prefix → button enables. Confirm → loop status flips to
  `cancelled` after the MCP round-trip; the cancel control
  disappears.
- Race check: with the same pending-approval loop, click **Approve**
  in the dashboard *and* send `/loop_approve` via Telegram in the
  same second. Expected: one wins, the other surfaces an
  `alreadyFinalized` toast cleanly (Phase 2 T06 race pattern reused
  per T4 review).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 5 — `/schedules` list + cron formatter (T5)

- Action: nav → `/schedules`. Confirm the list renders with columns:
  `name`, `agent`, truncated `prompt`, human-readable cron
  (`Every day at 9:00 AM`), `next_run`, `last_run`, paused state,
  run count.
- Expected: cron expressions render in plain English via
  `cronstrue`. Legacy interval-only schedules
  (`interval_minutes` set, `cron_expr` null) display "Every N
  minutes" via the fallback formatter. `next_run` reflects either
  the daemon-filled `nextRunAt` or a `cron-parser` computed value.
  Each row click opens the run history drawer (Step 8).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 6 — Schedule create form + cron picker + cost forecast (T6 + T9)

- Action: on `/schedules` click **New schedule**. The dialog mounts
  with: agent dropdown, prompt textarea, **cron picker** (preset
  radios `hourly` / `daily 9am` / `weekly Mon 9am` plus a `Custom`
  mode with raw input).
- Cron picker check:
  - Click each preset — the cron expression input auto-fills with
    `0 * * * *` / `0 9 * * *` / `0 9 * * 1`.
  - Switch to `Custom` and type `0 9 * * 1-5`. Live cronstrue
    preview reads "At 09:00 AM, Monday through Friday". The
    "Next 3 fire times" panel updates within ~200 ms.
  - Type `garbage`. Input border flashes red, cronstrue error
    tooltip shows, the **Create** button is disabled.
  - Type valid `*/15 * * * *`. Border returns to neutral, fire
    times list updates.
- Cost forecast block (T9): with a valid cron, an agent that has
  ≥ 3 historical cost samples, and the dialog still open — the
  block beneath the cron picker reads "Estimated spend: $X /
  month (likely range $Y – $Z, based on N samples)". Switching
  agents to one with no history → "Insufficient history — first
  run will calibrate forecast." Switching cron → forecast updates
  within 200 ms (race-guard token in `<ScheduleCreateDialog>`
  prevents stale results from clobbering newer ones).
- Submit check: pick `hourly`, fill name + prompt, submit.
- Expected: dialog closes; the new schedule appears on
  `/schedules` within 1 polling tick. DevTools — exactly one
  `POST /api/trpc/schedules.add` with `x-csrf-token`, response 200.
  `/audit` row `schedule.add` carries `{ agentName, cronExpr,
  intervalMinutes, runOnce }` — **prompt text NOT echoed**, only
  `hasPrompt: true`.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 7 — Pause / resume / delete schedule (T7)

- Action: on `/schedules`, locate the schedule from Step 6. Click
  the **Pause** icon button.
- Expected: the icon flips to **Play** within ~100 ms (optimistic
  via `runOptimistic` per Phase 2 T10). After the network round-
  trip the daemon-confirmed state matches. Click again → resumes.
- Rollback variant: with DevTools Network throttled to "Offline",
  click **Pause**. Expected: icon flips immediately, then *reverts*
  to the prior state when the request fails. Error toast
  ("pause failed — retry?").
- Delete: click the **Trash** icon. DangerConfirm modal opens —
  type the schedule name to enable the destructive button. Wrong
  name → button stays disabled. Correct name → button enables.
  Confirm → row disappears within 1 polling tick.
- DevTools check: Network — exactly one mutation per click,
  each with `x-csrf-token`. `/audit` rows `schedule.pause`,
  `schedule.resume`, `schedule.remove` all carry
  `{ id, name, agentName }`.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 8 — Schedule run history drawer (T8)

- Action: on `/schedules`, click any row (not on the icon buttons).
- Expected: a shadcn `<Sheet>` drawer slides in from the right
  within ~200 ms, listing the 30 most recent `tasks` rows where
  `task_type='schedule'` and `parent_task_id` matches the
  schedule's trigger heuristic (or `tasks.metadata` `LIKE` match —
  same approach the daemon takes per T8 review). Columns:
  status badge, started_at, cost, duration. Each row links to
  `/tasks/[id]` (Phase 1 T06 surface).
- Empty-state check: pick a freshly created schedule that has
  not fired yet. Drawer shows "No runs yet — first fire scheduled
  at <next_run>".
- Esc / overlay click closes the drawer; URL is unchanged
  (drawer is intentionally non-routable per T8 spec).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 9 — Audit covers every Phase 3 mutation (carries Phase 2 §12)

- Action: nav → `/audit`. Sort by `created_at desc`. Filter by
  `resource_type=loop`, then by `resource_type=schedule`.
- Expected: audit rows for every action you performed in steps
  3, 4, 6, 7:
  - `loop.start` × N (Step 3)
  - `loop.approve` / `loop.reject` × N (Step 4)
  - `loop.cancel` × N (Step 4 cancel variant)
  - `schedule.add` × N (Step 6)
  - `schedule.pause` / `schedule.resume` × N (Step 7)
  - `schedule.remove` × N (Step 7 delete)
  Each row carries `request_id`, `user_id`, `ip_hash` (hex), and
  a `payload_json` *without* the user-supplied free-text
  (`goal`, `prompt`, `reason`) — only the `hasGoal` /
  `hasPrompt` / `hasReason` boolean flags. Privacy invariant
  preserved.
- Filter by `action=rate_limit_blocked`. If you exhausted the
  bucket while clicking through Steps 6 + 7, the rejected
  attempts appear with `payload.path = "schedules.add"` (etc.)
  and `payload.bucket = "mutations"`.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

---

## Cross-cutting checks

- [ ] **Theme toggle** — switch dark ↔ light at any point during the
  flow. No FOUC, no console error. The new schedule create dialog,
  cron picker, run-history drawer, and cost-forecast block all re-
  theme cleanly.
- [ ] **DevTools Console** — zero errors, zero React-19 hydration
  warnings on every Phase 3 route + every dialog / drawer. Known
  noisy lines (EventSource reconnect from `/api/stream/tasks` and
  `/api/stream/permissions`) are bounded and documented in Phase 2.
- [ ] **DevTools Network** — every Phase 3 mutation request carries
  `x-csrf-token`; no `x-csrf-token` ever appears on a `GET`. Every
  successful mutation has a corresponding audit row within 1 s.
- [ ] **Logout + replay** — log out, then re-paste a `/loops?status=…`
  or `/schedules` URL. Expect redirect → `/login`. Log back in,
  the filter URL still works (URL-as-truth is auth-orthogonal).

---

## Playwright E2E summary (`bun run test:e2e`)

`tests/e2e/` ships **7 specs** (5 from Phase 2 + 2 new Phase 3).
Phase 3 specs are the machine-readable counterpart to the human
steps above:

| Spec | Asserts |
|------|---------|
| `smoke.spec.ts` | Phase 1 baseline: login → agents → tasks → task detail. |
| `dispatch-dialog.spec.ts` | Phase 2 — ⌘K dispatch mutation fires + toast renders link. |
| `csrf.spec.ts` | Phase 2 — POST `/api/trpc/*` without `x-csrf-token` returns 403; with valid token passes. |
| `rate-limit.spec.ts` | Phase 2 — 31st mutation within 60 s returns 429 + `Retry-After`. |
| `audit-view.spec.ts` | Phase 2 — `/audit` URL-as-truth filters round-trip; virtualizer DOM-row cap. |
| **`loop-flow.spec.ts`** | **Phase 3 — start dialog → cancel via typed-prefix DangerConfirm; approve gate on a pre-seeded pending loop.** |
| **`schedules-flow.spec.ts`** | **Phase 3 — create via cron picker (forecast block renders) → pause flip → typed-name delete.** |

Both new specs drive a fake stdio MCP daemon (`tests/e2e/fake-mcp.ts`)
configured via `playwright.config.ts` env `CLAUDE_BRIDGE_MCP_COMMAND`.
The fake daemon mutates the same SQLite fixture the dashboard reads,
so each follow-up navigation reflects the prior action — same fixture
pattern as Phase 2 e2e specs.

Run via `bun run test:e2e`. The single Phase 1 carry-over fail
(`smoke.spec.ts` calling Playwright `test()` under `bun test`) is
documented in `T13-review.md` (Phase 1) and is **not introduced by
Phase 3** — `bun run test` (scoped) stays clean at 946 / 0 fail.

---

## Sign-off

- Tester: _______________________________________
- Date: _________________________________________
- Browser / version: ____________________________
- Daemon version: _______________________________
- Overall: [ ] PASS / [ ] FAIL / [ ] PASS-WITH-NOTES

> If any step fails, file it under "Phase 4 entry blockers" before
> starting Phase 4 work. The Phase 3 mutation surface is the
> production user surface for goal loops + recurring schedules — a
> CSRF, audit, or confirmation gap here is user-visible.
