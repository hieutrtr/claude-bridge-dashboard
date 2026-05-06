# Phase 3 — Loop & Schedule UI — Task Index

> **Phase 3 goal (per v2 plan §Phase 3):** turn the daemon's two
> high-leverage but CLI-only features — goal loops and recurring
> schedules — into GUI surfaces in the dashboard. Mai (PM persona in
> the PRD) should be able to create & manage 5 schedules without ever
> training on the CLI.
>
> **Phase 3 invariant — INHERITED FROM PHASE 2 (do NOT relax):**
> every mutation procedure added in Phase 3 MUST:
> 1. Call the daemon's MCP tool surface — `bridge_loop`,
>    `bridge_loop_cancel`, `bridge_loop_approve`, `bridge_loop_reject`,
>    `bridge_schedule_add`, `bridge_schedule_pause`,
>    `bridge_schedule_resume`, `bridge_schedule_remove`. **No CLI
>    spawn, no direct table mutation** — same rule as Phase 2 T01.
> 2. Travel through the MCP pool from `src/server/mcp/pool.ts` (Phase 2
>    T12). Reuse it as-is per Phase 2 lesson §7 ("MCP transport is a
>    known quantity; do not fork the pool").
> 3. Carry a valid CSRF double-submit token (Phase 2 T08 — middleware
>    already wired in `app/api/trpc/[trpc]/route.ts`).
> 4. Pass the per-user rate-limit token bucket (Phase 2 T07 —
>    middleware already wired). Both new mutation surfaces (`loops.*`
>    and `schedules.*`) bind to the same 30-mutations/min/user bucket
>    as Phase 2 — no separate quota.
> 5. Be recorded in `audit_log` (Phase 2 T04) via `appendAudit({ ctx,
>    action, resource, payload })` BEFORE the MCP call returns.
>    `request_id` stays first-class on the tRPC ctx per Phase 2 lesson
>    §4 — do NOT make it optional.
> 6. Have a confirmation step for destructive actions — wrap with
>    `<DangerConfirm name=… verb=…>` from Phase 2 T11. Applies to T4
>    (cancel loop) and T7 (delete schedule). **Pause/resume are
>    reversible — no DangerConfirm**, just inline button.
>
> **Status:** Iter 1/11 — T0 (this INDEX + cron deps) being committed.

---

## Source plans

- v2 plan (current): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v2/IMPLEMENTATION-PLAN.md` — Phase 3 (~3 lines: "no change vs v1 path-rewrite, mutations go through MCP, cost forecast reads `bridge.db` via Drizzle").
- v1 plan (text inherited verbatim): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/IMPLEMENTATION-PLAN.md` — Phase 3 (P3-T1..P3-T9, lines 151–185).
- v2 architecture: `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v2/ARCHITECTURE.md` — §7.3 MCP transport reuse, §13 MCP tool design (NB: `bridge_dashboard_*` tools are Phase 5; `bridge_loop*` and `bridge_schedule_*` are existing daemon MCP tools already used by the bot).
- v1 architecture (load-bearing for this phase): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/ARCHITECTURE.md` — §3 data model (`loops`, `loop_iterations`, `schedules` columns), §4.3 `loops.*` procedure list, §4.4 `schedules.*`, §5 SSE multiplex (loop iter events), §10 security (rate-limit + CSRF apply equally to mutations added here).
- Phase 2 sign-off: `docs/tasks/phase-2/PHASE-2-COMPLETE.md` — see the
  "Lessons learned (carry into Phase 3)" section. Lessons §1, §2, §4,
  §6, §7 directly shape the sequencing & deliverables below.
- Phase 2 INDEX (sequencing pattern reference):
  `docs/tasks/phase-2/INDEX.md` — same structure as this file.

---

## What we inherit from Phase 2 (DO NOT rebuild)

All 12 Phase 2 tasks shipped on `main` (commits `87a4b2f` … `5fb71c9`,
plus the sign-off `b5fbd14`). Phase 3 builds *directly* on:

- `src/server/mcp/pool.ts` (T12) — single long-lived `bridge mcp-stdio`
  child; reconnect-on-EOF; pending-request queue cap = 32; chaos-tested.
  **Reuse as-is** per Phase 2 lesson §7.
- `src/server/csrf-guard.ts` + `app/api/trpc/[trpc]/route.ts` (T08) —
  tRPC POST mutations carry `x-csrf-token`; missing/mismatch → 403.
- `src/server/rate-limit-mutations.ts` (T07) — 30/min/user token bucket;
  audit row `rate_limit_blocked` on rejection.
- `src/server/audit.ts` + `appendAudit({ ... })` (T04) — every
  mutation calls this before returning. Adds `request_id` per Phase 2
  lesson §4.
- `src/components/danger-confirm.tsx` (T11) — `<DangerConfirm
  name=… verb=…>` primitive for destructive actions.
- `src/lib/optimistic.ts` + `runOptimistic` helper (T10) — used in
  Phase 3 wherever the round-trip is non-instant **and** semantics
  don't depend on the daemon's response. **Skip optimistic for
  cancel/approve/reject** (server-confirmed by design, per Phase 2
  review §d.1) — apply to schedule `pause`/`resume` only.
- `src/server/sse-tasks.ts` + `src/server/sse-permissions.ts` (T08
  P1 + T09 P2) — pattern for SSE multiplex. Phase 3 does **not** add
  a third SSE route; loop iteration events ride the existing
  `/api/stream/tasks` channel by joining on `task_id`. (Multiplexing
  into a single `/api/stream` is filed against Phase 4 per Phase 2
  follow-up note.)
- `src/server/routers/loops.ts` (T06) — already exposes `approve` +
  `reject`. Phase 3 extends this same router with `list`, `get`,
  `start`, `cancel`. **Same file**, do not fork.
- `src/server/routers/_app.ts` — `loopsRouter` already mounted; add
  `schedulesRouter` here in T5.
- Vendored Drizzle schema (`src/db/schema.ts`) — `loops`,
  `loop_iterations`, `schedules` tables already vendored. Read-only
  for the dashboard; mutations route through MCP.

**Out-of-scope for this loop** (filed against `claude-bridge`):
- `bun run sync-schema` daemon vendor automation (Phase 2 lesson §5,
  P1-T14). Still deferred — Phase 3 does not add new dashboard-owned
  tables, so this remains a Phase 4 entry blocker not a Phase 3 one.
- Daemon-side audit log writes joined on `request_id` (Phase 2
  follow-up note). Audit forensics for Phase 3 mutations are still
  dashboard-side-only.

---

## Phase 3 task list — 9 tasks (P3-T1 … P3-T9)

Per the user-supplied 11-step loop plan, Phase 3 lands in **9 atomic
task commits** (this INDEX = step 1, sign-off = step 11). Acceptance
criteria are inherited verbatim from v1 plan lines 157–183 with Phase
2 invariant additions (CSRF/rate-limit/audit/confirm) made explicit.

### T1 — `loops.list` + Loops page

**Scope:** Add `loops.list({ status?, agent?, cursor?, limit? })` query
to `src/server/routers/loops.ts`. Build `/loops` page listing all loops
with columns: `loop_id` (truncated), `agent`, `status` (running |
waiting_approval | done | cancelled | failed), `current_iteration` /
`max_iterations`, total_cost / max_cost ("budget remaining"). Status
filter pill row reuses the `<TaskFilters>` URL-as-truth pattern from
Phase 1 T05 / Phase 2 T05. Click row → `/loops/[loopId]` (T2).
**Read-only** — no mutations in this task. Replaces the placeholder at
`app/loops/page.tsx`.
**Deps:** Phase 2 baseline. **Risk:** Low.
**Acceptance:** filter status round-trips through URL params; table
renders 100 loops without virtualization (volume well below virtualizer
threshold); empty / loading / error states reuse Phase 1 T11
primitives.

### T2 — Loop detail page (timeline + cost sparkline)

**Scope:** Add `loops.get({ loopId })` query returning the loop row +
`loop_iterations[]` (latest 100, ascending by `iteration_num`). Build
`/loops/[loopId]` showing: header card (agent, goal, done_when, status,
budget bar), iteration timeline (each iter expandable: prompt / result
summary / done_check_passed / cost / duration), cumulative-cost
sparkline using `recharts` (already a dependency, used by `/cost`).
Each iter row collapsed by default (acceptance: 50 iters render
smoothly, lazy-expand on click). Iter row links to its
`/tasks/[taskId]` (cross-link from T05/T06 in Phase 1).
**Deps:** T1 (router file scaffold). **Risk:** Low.
**Acceptance:** 50-iter loop renders in < 200ms (no virtualization
needed at this scale); sparkline reflects cumulative cost; collapse
state stays per-iter (no global toggle).

### T3 — Start new loop dialog

**Scope:** Add `loops.start({ agent, goal, doneWhen, maxIterations,
maxCostUsd?, loopType?, channelChatId?, planEnabled? })` mutation to
`loopsRouter`. Mutation calls daemon MCP tool `bridge_loop` (15s
timeout — same as approve/reject in T06). On success returns `{ loopId
}` and page redirects to `/loops/[loopId]`. UI: button on `/loops`
("Start loop") opens shadcn `<Dialog>` with form (agent dropdown via
`agents.list`, goal textarea, `done_when` dropdown with templates
`command:`, `file_exists:`, `file_contains:`, `llm_judge:`, `manual:`,
plus a free-form text field for the value, max_iter spinner default 10,
max_cost_usd input).
**Mutation Phase 3 invariant checklist:**
- [x] CSRF token sent on POST → middleware validates.
- [x] Rate limit applies (30/min/user — same bucket as dispatch).
- [x] `appendAudit` BEFORE returning, action `loop.start`,
      payload `{ agent, doneWhen, maxIterations, maxCostUsd,
      planEnabled }`. **Goal text is NOT echoed** — privacy precedent
      from T06 reject reason. `payload.hasGoal: true` instead.
- [x] No optimistic UI — start mutation produces a server-side `loop_id`
      we don't predict client-side.
- [x] Confirmation NOT applicable (start is a creation, not destructive).
**Deps:** T1. **Risk:** Medium — `done_when` evaluator validation
client-side (regex `^(command|file_exists|file_contains|llm_judge|manual):.*`).
**Acceptance:** submit closes dialog and redirects to `/loops/[id]`
within 1s; daemon error surfaces as toast (re-uses `mapMcpErrorToTrpc`).

### T4 — Cancel loop + approve/reject gate UI on `/loops/[id]`

**Scope:** Inline cancel + approve / reject controls on the loop
detail page. Adds `loops.cancel({ loopId })` mutation calling daemon
MCP `bridge_loop_cancel` (idempotent — same race-pattern handling as
approve/reject from T06). Approve / reject already exist on tRPC
(`loops.approve` / `loops.reject` from Phase 2 T06) — Phase 3 adds the
*loop-detail-page* surface (Phase 2 wired them only on the
task-detail page). Approve / Deny render as **large** buttons (per the
v1 acceptance "Allow/Deny lớn") at the top of the detail card when
`pending_approval=true`.
**Mutation Phase 3 invariant checklist:**
- [x] Cancel goes through daemon MCP `bridge_loop_cancel` (NOT a direct
      `loops` table mutation).
- [x] CSRF + rate limit (re-uses existing middleware).
- [x] `appendAudit` action `loop.cancel`, payload includes
      `{ status, alreadyFinalized? }` — same idempotency shape as T06.
- [x] Cancel is **destructive** — wrap button with `<DangerConfirm
      name={loopId.slice(0,8)} verb="cancel">` from Phase 2 T11.
- [x] Approve / reject are **NOT** wrapped in DangerConfirm —
      consistent with Phase 2 T06 (server-confirmed but the
      semantic act is "advance the loop", not "destroy state").
- [x] No optimistic — server-confirmed (race window vs Telegram, per
      Phase 2 T06).
**Deps:** T2 (renders inside detail page), Phase 2 T11 (DangerConfirm),
Phase 2 T06 (approve/reject mutations). **Risk:** Low.
**Acceptance:** 1-click cancel after typing the loop-id prefix; approve
/ reject buttons disappear after success; race against Telegram fires
`alreadyFinalized:true` toast cleanly.

### T5 — `schedules.list` + Schedules page

**Scope:** Add `src/server/routers/schedules.ts` exposing `list({
agent? })` query reading from the vendored `schedules` table. Build
`/schedules` page (replace placeholder) with columns: `name`, `agent`,
`prompt` (truncated), cron expression formatted **human-readable**
("Every day at 9:00 AM" via `cronstrue.toString(cronExpr)`), `next_run`
(ISO from `nextRunAt` column or computed via `cron-parser` if the
daemon hasn't filled it), `last_run`, paused state (toggle disabled in
T5 — wired in T7), run count.
**Deps:** Phase 2 baseline + cron-parser/cronstrue deps installed in
T0 (this commit). **Risk:** Low.
**Acceptance:** cron expressions render in plain English; bare
`interval_minutes`-only schedules (legacy daemon shape) display "Every
N minutes" via fallback formatter; row click opens history drawer
(stub — fully wired in T8).

### T6 — Schedule create form + cron picker

**Scope:** Add `schedules.add({ name, agentName, prompt,
intervalMinutes? | cronExpr?, runOnce?, channelChatId? })` mutation
calling daemon MCP `bridge_schedule_add`. Build a "New schedule"
dialog containing: agent dropdown, prompt textarea, **cron picker
component** (new file
`src/components/cron-picker.tsx`) — preset radio for
`hourly` (`0 * * * *`), `daily 9am` (`0 9 * * *`), `weekly Mon 9am`
(`0 9 * * 1`), plus a "Custom" mode with raw input + live
cron-parser validation + cronstrue preview. Validation errors block
submit. Show next 3 fire times computed via `cron-parser` so user
sees what they're agreeing to.
**Mutation Phase 3 invariant checklist:**
- [x] Daemon MCP `bridge_schedule_add` (no DB write here).
- [x] CSRF + rate limit (existing middleware).
- [x] `appendAudit` action `schedule.add`, payload `{ agentName,
      cronExpr | intervalMinutes, runOnce }`. **Prompt text NOT
      echoed** — privacy precedent.
- [x] No optimistic UI (creation generates a server-side `id`).
- [x] No DangerConfirm (creation is not destructive).
**Deps:** T5 (router file scaffold), T0 (cron deps). **Risk:** Medium —
cron picker UX is the only novel component in this phase.
**Acceptance:** preset selection auto-fills cron field; custom-mode
invalid expression shows red border + cronstrue error tooltip; "next
3 fire times" preview updates as user types; submit closes dialog and
schedule appears in `/schedules` table within 1 polling tick.

### T7 — Pause / resume / delete schedule (inline action menu)

**Scope:** Add three mutations:
- `schedules.pause({ id })` → daemon MCP `bridge_schedule_pause`
- `schedules.resume({ id })` → daemon MCP `bridge_schedule_resume`
- `schedules.remove({ id })` → daemon MCP `bridge_schedule_remove`

Inline icon buttons on each `/schedules` row (pause icon flips
to play when paused; trash icon for delete). Pause / resume are
**reversible** — apply Phase 2 T10 `runOptimistic` (Phase 2 lesson §6
applies — invisible feels-fast UX for the reversible pair). Delete
is **destructive** — wrap trash button with `<DangerConfirm
name={schedule.name} verb="delete">`.
**Mutation Phase 3 invariant checklist:**
- [x] All three call MCP tools (no DB mutation).
- [x] CSRF + rate limit (existing middleware).
- [x] `appendAudit` actions `schedule.pause`, `schedule.resume`,
      `schedule.remove` — payload `{ id, name, agentName }`.
- [x] Optimistic on pause/resume only (Phase 2 lesson §6).
- [x] DangerConfirm on delete only — pause/resume reversible.
**Deps:** T5 (router scaffold), T0 (already done), Phase 2 T10
(`runOptimistic`), Phase 2 T11 (`DangerConfirm`). **Risk:** Low.
**Acceptance:** pause toggles within 100ms (optimistic) and rolls back
on simulated 500; delete requires typing the schedule name; all three
audit rows visible on `/audit` page filtered by `resource_type=schedule`.

### T8 — Schedule run history drawer

**Scope:** Add `schedules.runs({ id, limit?: 30 })` query returning the
30 most recent `tasks` rows where `task_type='schedule'` and
`parent_task_id` matches schedule trigger heuristic (or `tasks.metadata
LIKE '%schedule_id":<id>%'` — same approach the daemon takes). Reuse
the Phase 1 `<TaskTable>` minimal view inside a shadcn `<Sheet>`
(side drawer) opened on row click in `/schedules`. Each run row
links to `/tasks/[id]` (existing route from Phase 1 T06). Show
status badge per run + cost + duration.
**Deps:** T5. **Risk:** Low.
**Acceptance:** drawer opens within 200ms; 30-row table renders
without lag; "view full task →" link goes to `/tasks/[id]`.

### T9 — Cost forecast (helper + UI on schedule create form)

**Scope:** New helper at `src/lib/cost-forecast.ts` —
`forecastSchedule({ agentName, cronExpr | intervalMinutes, lookbackDays
}) → { runsPerMonth, avgCostPerRun, lowEstimate, highEstimate, sample
}`. Forecast logic:
1. Read last N (default 30) `tasks` for the agent with
   `task_type='schedule'` (or fall back to standard tasks if no
   schedule history yet).
2. Compute median + p10 + p90 of `cost_usd`.
3. Use `cron-parser.CronExpressionParser.parse(cronExpr)` to count
   fire times in next 30 days (or `(60 / intervalMinutes) * 24 *
   30` for interval mode).
4. Multiply: `low = runs * p10`, `high = runs * p90`,
   point estimate = median × runs.
Render the forecast inline in the T6 dialog: "Estimated spend: $X /
month (likely range $Y – $Z, based on N samples)". When sample size <
3 → render "Insufficient history — first run will calibrate forecast."
**Deps:** T6 (renders inside that dialog), T0 (cron-parser dep).
**Risk:** Low.
**Acceptance:** forecast helper returns `{ runsPerMonth }` accurate
within ±1 across hourly/daily/weekly/interval variants; UI shows
forecast within 200ms of cron change; estimate is "± 30%" of actual
after 30 days (deferred validation per v1 P3-T9 acceptance — this
loop validates the **shape**, not the **accuracy** which needs real
data).

---

## Dependency graph

```
                ┌──────────────────────────────────┐
                │  P2 baseline (DONE — main)       │
                │  - MCP pool (T12)                │
                │  - CSRF guard (T08)              │
                │  - Rate limit (T07)              │
                │  - Audit log + appendAudit (T04) │
                │  - DangerConfirm (T11)           │
                │  - runOptimistic (T10)           │
                │  - loops.{approve,reject} (T06)  │
                │  - SSE /tasks /permissions       │
                └────────────────┬─────────────────┘
                                 │
                       ┌─────────▼──────────┐
                       │ T0  INDEX + cron   │  ← FOUNDATION (this commit)
                       │ deps (cron-parser, │
                       │      cronstrue)    │
                       └──────┬──────┬──────┘
                              │      │
              ┌───────────────┘      └────────────────┐
              │                                       │
   ╔══════════▼═══════════╗               ╔═══════════▼══════════╗
   ║ LOOPS VERTICAL       ║               ║ SCHEDULES VERTICAL    ║
   ╚══════════════════════╝               ╚══════════════════════╝
              │                                       │
        ┌─────▼────────┐                       ┌──────▼──────────┐
        │ T1 loops.list│                       │ T5 schedules.   │
        │  + /loops    │                       │  list + page    │
        └─┬───────┬────┘                       │  (cronstrue fmt)│
          │       │                            └─┬──────┬──────┬─┘
   ┌──────▼──┐ ┌──▼────────┐         ┌───────────▼┐ ┌───▼──┐ ┌─▼──────┐
   │ T2 loop │ │ T3 start  │         │ T6 create  │ │ T7   │ │ T8 run │
   │  detail │ │ dialog    │         │  + cron    │ │pause │ │history │
   │ + spark │ │ (mutation)│         │  picker    │ │/resume│ │ drawer │
   └────┬────┘ └───────────┘         │ (mutation) │ │/delete│ └────────┘
        │                            └─────┬──────┘ │(mut.) │
        ▼                                  │        └────────┘
   ┌─────────────────┐                     ▼
   │ T4 cancel +     │              ┌──────────────┐
   │  approve/reject │              │ T9 cost      │
   │  on /loops/[id] │              │   forecast   │
   │  (uses T11      │              │  inline in   │
   │   DangerConfirm)│              │  T6 dialog   │
   └─────────────────┘              └──────────────┘
```

### Critical path

```
T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → phase-test
```

The two verticals are largely independent after T0 — could parallelize
in theory, but the loop runs serially one task per iter. T6 needs T0
(cron deps) and T5 (router scaffold). T9 needs T6 (renders inside its
dialog).

### Iteration mapping (loop steps 1..11)

| Step | Task         | Why this slot                                              |
|------|--------------|------------------------------------------------------------|
| 1    | T0 INDEX     | Foundation — sets invariant, dep graph, sequencing         |
| 2    | T1           | Read-only, vertical-slice entry; gives router scaffold     |
| 3    | T2           | Builds on T1's router; adds first complex viz (timeline)   |
| 4    | T3           | First Phase-3 mutation; rehearses CSRF/rate/audit/MCP path |
| 5    | T4           | Cancel + a/r — destructive surface; exercises DangerConfirm|
| 6    | T5           | Schedules vertical entry; same shape as T1                 |
| 7    | T6           | Cron picker is the only novel component this phase         |
| 8    | T7           | Pause/resume optimistic + delete destructive               |
| 9    | T8           | Read-only drawer; reuses Phase 1 task-table primitives     |
| 10   | T9           | Cost forecast — needs real schedule data from T7 to test   |
| 11   | Phase test   | E2E + browser test + sign-off                              |

---

## Sequencing decision — vertical-then-vertical (NOT cross-cut)

Phase 2 used a **foundation-first hybrid** (transport + guards before
mutations). Phase 3 inherits the foundation already — there is nothing
new to harden cross-cuttingly — so we sequence by **vertical slice**:
loops vertical entirely (T1→T2→T3→T4) then schedules vertical entirely
(T5→T6→T7→T8→T9).

**Rationale (counter-recommendation to a "two foundation tasks then
verticals" split):**

1. **No new cross-cutting infra**. Every guard, transport, audit
   helper, and confirmation primitive Phase 3 mutations need *already
   exists* on `main` from Phase 2. There is no T12-equivalent
   foundation task to land first. Re-running the foundation-first
   ceremony for nothing would be cargo-cult per Phase 2 lesson §1
   ("risk isolation comes from sequencing, not from sub-phase
   ceremonies").
2. **Vertical reduces context-switch cost**. The agent loop runs one
   task per iter; finishing the loops feature end-to-end before
   touching schedules keeps the working set small (one router, one
   page tree, one set of tests) per iter.
3. **T9 needs T7's audit & data shape**. The cost-forecast helper
   reads `tasks.cost_usd` filtered by agent + task_type, which only
   gets populated meaningfully *after* schedules can fire. Sequencing
   T9 last lets us write its tests against actual schedule rows
   inserted via T7, not synthetic fixtures.
4. **T0 (this commit) IS the foundation**. cron-parser and cronstrue
   are dependencies of T5/T6/T9; landing them in T0 means later
   commits don't carry "deps + feature" mixed diffs — same hygiene
   Phase 2's T12 commit produced for `mcp/pool.ts`.

**Caveat that would flip the decision:** if T1 (iter 2) reveals that
the daemon does not expose `bridge_loop` as a callable MCP tool over
stdio (Phase 5 ARCHITECTURE.md §13 lists only `bridge_dashboard_*`
tools as Phase-5-NEW; the loop / schedule MCP tools are pre-existing
in the bot's MCP surface — see `CLAUDE.md` MCP tools list), we abort
and ship a read-only Phase 3 (T1, T2, T5, T8 — list + detail + history)
plus deferred mutations as a 3.5 follow-up. The loop will surface this
in T3's iter (step 4) when we first try to call `bridge_loop` through
the pool.

**Open architectural concerns we resolve in-line (not deferred):**

- **Does `bridge_loop_cancel` exist as MCP tool?** Yes — listed in
  `CLAUDE.md` (`bridge_loop_cancel({ loop_id })`). T4 spec encodes the
  call shape.
- **Does `bridge_schedule_add` accept cron OR interval?** Yes — per
  `CLAUDE.md` it takes `interval_minutes`. **Cron-mode acceptance
  needs verification at T6** — if daemon only takes
  `interval_minutes`, T6 falls back to interval-from-cron conversion
  client-side and persists `intervalMinutes` only. This is a known
  daemon-side gap; T6 spec will record the decision once verified.
- **Loop iteration SSE feed.** v1 ARCH §5 describes
  `/api/stream?topics=tasks,loops,agents` multiplex. Phase 2 lesson §3
  + follow-up note already flagged this as a Phase-3-or-later concern.
  Phase 3 does **not** add a separate `/api/stream/loops` route —
  per Phase 2 lesson §3 it's the right time to multiplex, but doing
  it in Phase 3 inflates scope. T2 polls every 2s for now; multiplex
  filed against Phase 4. (Phase 2 follow-up section §3 already
  documents this; restating here.)
- **Cost forecast accuracy validation.** v1 P3-T9 acceptance says
  "± 30% so với thực tế sau 1 tháng". This loop cannot validate that
  empirically (no production data yet). T9 spec encodes that the
  acceptance for *this loop* is "shape correctness" (output schema +
  unit-test coverage on the math), and "accuracy ±30%" is filed
  against `claude-bridge-dashboard` as a 30-day-after-launch task.

---

## Test surface plan

Per Phase 2 INDEX precedent — every task ships unit + integration +
component coverage, plus E2E for critical mutation flows.

| Task | Server tests                       | Lib tests              | Component tests             | E2E (Playwright)            |
|------|-------------------------------------|------------------------|------------------------------|-----------------------------|
| T1   | `loops-router.test.ts` (extend)     | —                      | `loops-page.test.ts`        | (covered by T3 spec)        |
| T2   | `loops-router.test.ts` (extend)     | —                      | `loop-detail.test.ts`       | —                           |
| T3   | `loops-router.test.ts` (extend)     | —                      | `loop-start-dialog.test.ts` | `loop-start-cancel.spec.ts` |
| T4   | `loops-router.test.ts` (extend)     | —                      | `loop-cancel-control.test.ts` | (same spec as T3)         |
| T5   | `schedules-router.test.ts` (new)    | `cron-format.test.ts`  | `schedules-page.test.ts`    | —                           |
| T6   | `schedules-router.test.ts` (extend) | `cron-picker-state.test.ts` | `cron-picker.test.ts`  | `schedule-create.spec.ts`   |
| T7   | `schedules-router.test.ts` (extend) | —                      | `schedule-actions.test.ts`  | `schedule-pause-delete.spec.ts` |
| T8   | `schedules-router.test.ts` (extend) | —                      | `schedule-runs-drawer.test.ts` | —                        |
| T9   | —                                   | `cost-forecast.test.ts`| `cost-forecast-display.test.ts` | —                       |

**Phase 3 E2E target:** 3 specs (`loop-start-cancel`, `schedule-create`,
`schedule-pause-delete`), bringing Playwright total from 5 → 8.
Continue using the contract-level pattern from Phase 2 (Network
assertions on status + `x-csrf-token` header echo) — SPA-click
coverage stays deferred per Phase 2 follow-up §5.

---

## Architecture references per task (read before coding)

| Task | Sections to read |
|------|------------------|
| T1   | v1 ARCH §3 (`loops` columns), §4.3 (`loops.list/get`), §11 (table virtualization threshold) |
| T2   | v1 ARCH §3 (`loop_iterations` columns), §11 (sparkline rendering); Phase 1 T09 cost-charts as recharts reference |
| T3   | v1 ARCH §4.3 `loops.start`; daemon `CLAUDE.md` `bridge_loop` tool args; Phase 2 T01 dispatch as MCP-mutation reference |
| T4   | v1 ARCH §4.3 `loops.cancel`; daemon `bridge_loop_cancel`; Phase 2 T06 race-pattern handling (re-use `LOOP_RACE_PATTERN`) |
| T5   | v1 ARCH §3 `schedules` columns, §4.4; cron-parser README (next() iterator); cronstrue API |
| T6   | v1 ARCH §4.4 `schedules.add`; daemon `CLAUDE.md` `bridge_schedule_add` (note: only `interval_minutes` exposed today — cron→interval conversion noted above) |
| T7   | v1 ARCH §4.4 `schedules.{remove,pause,resume}`; Phase 2 T10 `runOptimistic` shape; Phase 2 T11 `<DangerConfirm>` |
| T8   | v1 ARCH §3 `tasks` columns (`task_type`, `parent_task_id`); Phase 1 T05 `<TaskTable>` reuse |
| T9   | v1 P3-T9 acceptance; cron-parser iteration counting; v1 ARCH §3 `cost_usd` column on tasks |

---

## Notes / open questions

- **`bun run sync-schema`** — Phase 2 follow-up §3 raised it as a
  Phase 3 entry blocker. Phase 3 does NOT touch the dashboard-vendored
  schema (`audit_log` is the only dashboard-owned table; loops &
  schedules are daemon-owned and already vendored). We are not
  blocked. Re-flagged for Phase 4 instead.
- **Confirmation pattern UX**: Phase 2 T11 used "type the agent name
  / task ID prefix to enable" — Phase 3 inherits and applies the same
  to: T4 cancel (type `loop_id` prefix, 8 chars), T7 delete (type
  schedule `name`).
- **Audit privacy precedent**: T06 (Phase 2) does not echo `reason`
  text; instead writes `hasReason: true`. Phase 3 extends the same
  rule to T3 `goal` text and T6 `prompt` text — payload writes
  `hasGoal: true` / `hasPrompt: true` only.
- **Optimistic UI scope decision (carrying Phase 2 §d.1 forward)**:
  apply ONLY to T7 pause/resume. T3 start, T4 cancel, T4 approve, T4
  reject, T6 add, T7 delete, T8 query — all server-confirmed.
- **`request_id` invariant** — Phase 2 lesson §4 mandates first-class.
  Re-affirmed: every Phase 3 mutation passes `req_id` through tRPC ctx
  to `appendAudit`. Do not make optional.
- **Pre-existing untracked files** (`MIGRATION-COMPLETE.md`,
  `docs/PHASE-2-REVIEW.md`, `tests/e2e/.fixture/`) — same as Phase 2,
  carried into Phase 3. Not touched by this loop.
- **No `git push`** during the loop — user reviews diff before
  shipping, same constraint as Phase 2.
- **Cron daemon-side gap**: if `bridge_schedule_add` daemon tool only
  accepts `interval_minutes` (per `CLAUDE.md` listing), T6 stores
  `cron_expr` only as a UI-side label and converts to interval on
  submit. Convert via `cron-parser` `next()` deltas; if non-uniform
  intervals (e.g. `0 9 * * 1-5` → not constant), reject with
  validation error. Final decision recorded in T6's review file.

---

*Index written by loop iter 1/11 on 2026-05-06. Update checkboxes as
tasks land. If a task spec changes mid-loop, edit its
`T<NN>-<slug>.md` and note the delta here.*
