# Phase 1 — Browser Test Plan (Manual)

> **Why manual:** the loop runner cannot drive an interactive browser
> beyond the Playwright smoke spec (T13). This plan is the gate before
> handing Phase 1 off — a human follows it once and signs at the
> bottom. Playwright covers the contract (each route renders + each
> link's `href` is correct); this plan covers the *experience* (clicks
> feel responsive, SSE updates flow, no console errors).
>
> **Pre-req:** `bridge.db` reachable via `discoverBridgeDaemon()` (i.e.
> `~/.claude-bridge/config.json` exists and points to a populated SQLite
> with ≥ 1 agent and ≥ 1 task — production daemon will satisfy this).

---

## Setup (run once)

```sh
cd /Users/hieutran/projects/bridge-bot-ts-1/claude-bridge-dashboard
bun install                               # if cold
DASHBOARD_PASSWORD=test bun dev           # boots on :3000
# In another shell, leave the dev server logs visible to spot warnings.
```

Open http://localhost:3000 — middleware should redirect to `/login`.
Log in with `test`. From here, every step assumes you stay logged in
(JWT cookie, 7-day exp).

---

## Steps

### Step 1 — Login + home

- Action: open `http://localhost:3000`.
- Expected: redirect → `/login`. Submit password `test` →
  redirect → `/`. Sidebar visible: Agents / Tasks / Loops / Schedules
  / Cost. Topbar visible with theme toggle.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 2 — Agents grid

- Action: click "Agents" in sidebar (or nav `/agents`).
- Expected: Card grid renders ≥ 1 agent (production should have
  20+). Each card shows: agent name, project name, model badge,
  total tasks, last task time. No layout shift after FCP.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 3 — Agent detail (Tasks tab)

- Action: click any agent card.
- Expected: route `/agents/<name>`. Tabs: **Tasks** / **Memory** /
  Cost (Cost is placeholder text — Phase 2). Tasks tab default —
  table of 50 most recent tasks, columns: id, status, prompt
  preview, cost, started. Pagination "Next →" if > 50.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 4 — Tasks (global)

- Action: nav → `/tasks` (sidebar).
- Expected: global task table (50/page, paginated). Filter form
  (`<form method="get">`) has status / agent / channel / since /
  until inputs. Submitting filters mutates URL `?status=…` and
  re-renders. Each row's id is a link → `/tasks/<id>`.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 5 — Task detail + transcript + SSE

- Action: from `/tasks`, click a task id whose status is `running`
  (if none, pick `done` — SSE will be no-op but page still renders).
- Expected: route `/tasks/<id>`. Header (status badge, cost,
  duration), prompt section, result markdown rendered (sanitized).
  Transcript card renders turns from JSONL.
- SSE check: open DevTools → Network → "EventStream" tab. Filter
  `/api/stream/tasks`. Expect a single event-stream connection,
  heartbeat every ~15s, status events when a task changes. Open a
  second tab and run a `bridge dispatch` from CLI — task list
  status should update in this tab without manual refresh.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 6 — Loops

- Action: nav → `/loops`.
- Expected: list page. Phase 1 is read-only — page may render an
  empty-state placeholder ("Loops view — Phase 2") if the route
  was scaffolded but list query is deferred. **This is acceptable
  for Phase 1 sign-off** (the task list does not include
  `loops.list` query — Loops detail is Phase 2).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 7 — Schedules

- Action: nav → `/schedules`.
- Expected: same as Step 6 — list or empty-state placeholder. No
  schedule mutation UI (defer Phase 2).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 8 — Cost analytics

- Action: nav → `/cost`.
- Expected: 3 KPI cards (total spend, agent count, task count) +
  three charts: daily-spend line (30 days), per-agent pie,
  per-model bar. Numbers should match `bridge cost` CLI output ±
  $0.01. Empty state if zero tasks.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 9 — Memory tab (under agent detail)

- Action: back to `/agents/<name>` → click "Memory" tab.
- Expected: renders `MEMORY.md` markdown if present, list of
  sibling `*.md` files (≤ 200 chips, ascending). Empty-state
  branch if the agent has no memory dir yet. **Note**: there is
  no top-level `/memory` route in Phase 1 — Memory is per-agent
  by design (T10 scope).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

---

## Cross-cutting checks

- [ ] Theme toggle (top-right) — switch dark ↔ light, no FOUC, no
  console error, persists across reload.
- [ ] DevTools Console — zero errors, zero React-19 hydration
  warnings on every route above.
- [ ] DevTools Network — every page first-load JS < 250 KB
  (Recharts on `/cost` may push to ~210 KB; that is the hot
  spot).
- [ ] Logout — kill the JWT cookie and re-visit `/agents`; expect
  redirect to `/login`.

---

## Playwright E2E summary (T13, automated)

`bun run test:e2e` — single chromium spec, ~18.5s, drives:
login → `/agents` → `/agents/[name]` → `/tasks` → `/tasks/[id]`.
3/3 stability runs green at last check (T13 review). Asserts each
link's `href` and uses `page.goto` for the navigation itself
(SPA-click coverage deferred — see T13 issue #2). The smoke is the
contract test; this manual plan is the experience test.

---

## Sign-off

- Tester: _______________________________________
- Date: _________________________________________
- Browser / version: ____________________________
- Overall: [ ] PASS / [ ] FAIL / [ ] PASS-WITH-NOTES

> If any step fails, file it under "Phase 2 entry blockers" before
> starting Phase 2 work.
