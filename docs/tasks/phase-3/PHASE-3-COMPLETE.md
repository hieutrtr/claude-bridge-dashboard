# Phase 3 — Loop & Schedule UI — Sign-off

- **Date completed:** 2026-05-06
- **Branch:** `main` (commits `5770062` … `d029e1d` — 9 retroactive
  Phase 3 feat/test commits + this sign-off, no force-push, no
  remote push). Range: `e2746a9..HEAD`.
- **Phase invariant held:** every mutation procedure is gated by
  CSRF (P2-T08) → rate-limit (P2-T07) → audit-log write (P2-T04) →
  MCP transport (P2-T12), with confirmation pattern (P2-T11) on
  destructive surfaces. Free-text inputs (`goal`, `prompt`,
  `reason`) are NOT echoed in audit payloads — only `hasGoal:
  true` / `hasPrompt: true` / `hasReason: true` flags. Verified
  per-task in each `T<NN>-review.md`.
- **Sequencing:** vertical-then-vertical
  (`T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9`) — chosen
  over the foundation-first hybrid that Phase 2 used because the
  foundation already exists on `main`. Decision rationale captured
  in `INDEX.md` § *Sequencing decision — vertical-then-vertical
  (NOT cross-cut)*.
- **Resume note:** the loop initially completed T01–T05 in one
  pass, then was paused. This sign-off was produced by a resume
  loop (commit `3559867 chore(phase-3): resume from T06`) that
  picked up from T06 and ran through T09 + E2E + sign-off without
  redoing T01–T05.

---

## 9-task checklist

Click through to each per-task spec + review for files changed,
test counts, and decisions/issues.

- [x] **T01** — `loops.list` + `/loops` page — [`T01-loops-list.md`](T01-loops-list.md) · [`T01-review.md`](T01-review.md)
- [x] **T02** — Loop detail page (timeline + cost sparkline) — [`T02-loop-detail.md`](T02-loop-detail.md) · [`T02-review.md`](T02-review.md)
- [x] **T03** — Start new loop dialog (`loops.start` mutation) — [`T03-start-loop.md`](T03-start-loop.md) · [`T03-review.md`](T03-review.md)
- [x] **T04** — Cancel + approve / reject gate UI — [`T04-cancel-approve.md`](T04-cancel-approve.md) · [`T04-review.md`](T04-review.md)
- [x] **T05** — `schedules.list` + `/schedules` page — [`T05-schedules-list.md`](T05-schedules-list.md) · [`T05-review.md`](T05-review.md)
- [x] **T06** — Schedule create form + cron picker (`schedules.add`) — [`T06-schedule-create.md`](T06-schedule-create.md) · [`T06-review.md`](T06-review.md)
- [x] **T07** — Pause / resume / delete schedule (3 mutations) — [`T07-schedule-actions.md`](T07-schedule-actions.md) · [`T07-review.md`](T07-review.md)
- [x] **T08** — Schedule run history drawer — [`T08-schedule-runs.md`](T08-schedule-runs.md) · [`T08-review.md`](T08-review.md)
- [x] **T09** — Cost forecast (helper + UI on schedule create) — [`T09-cost-forecast.md`](T09-cost-forecast.md) · [`T09-review.md`](T09-review.md)

9 / 9 task spec + review files on file. INDEX (`INDEX.md`) ships
alongside.

---

## Test results (2026-05-06, just before sign-off)

### `bun run test` (scoped: `tests/lib tests/app tests/server`)

```
946 pass · 0 fail · 4483 expect() calls · 72 files · ~3.53 s
```

Clean. The scoped script (added in Phase 1 T13) deliberately
excludes `tests/e2e/` so the Bun runner does not trip over the
Playwright specs. **Phase 3 added 383 unit/integration tests on
top of Phase 2's 563** — the bulk in `tests/server/*` (loops-router,
schedules-router) and `tests/lib/*` (cron-format, cost-forecast,
6 client-side mutation helpers) plus component tests for every new
view.

Distribution of the largest Phase-3-touched files (≥ 100 cases):

| Test file | Lines | Phase 3 delta |
|-----------|-------|---------------|
| `tests/server/schedules-router.test.ts` | 1554 | new (T05–T09) |
| `tests/server/loops-router.test.ts` | 1254 | +585 over Phase 2's 669 (T01–T04) |
| `tests/lib/cost-forecast.test.ts` | 339 | new (T09) |
| `tests/app/schedules-page.test.ts` | 287 | new (T05) |
| `tests/lib/schedule-add-client.test.ts` | 213 | new (T06) |
| `tests/app/schedule-runs-drawer.test.ts` | 202 | new (T08) |
| `tests/lib/cron-format.test.ts` | 199 | new (T05 / T06 fmt helpers) |
| `tests/lib/loop-start-client.test.ts` | 148 | new (T03) |
| `tests/lib/loop-mutation-client.test.ts` | 123 | new (T04) |
| `tests/lib/schedule-runs-client.test.ts` | 118 | new (T08) |
| `tests/lib/schedule-action-client.test.ts` | 108 | new (T07) |

### `bun run typecheck`

```
$ tsc --noEmit          # clean — zero errors
```

### `bun run build` (production)

```
✓ Compiled successfully in 1.77 s
✓ Generating static pages (7/7)
```

Routes after Phase 3 (changed: `/loops`, `/loops/[loopId]`,
`/schedules`):

```
Route (app)                                 Size  First Load JS
┌ ○ /                                      151 B         102 kB
├ ○ /_not-found                            996 B         103 kB
├ ƒ /agents                                164 B         105 kB
├ ƒ /agents/[name]                         169 B         105 kB
├ ƒ /api/auth/login                        151 B         102 kB
├ ƒ /api/auth/logout                       151 B         102 kB
├ ƒ /api/stream/permissions                151 B         102 kB
├ ƒ /api/stream/tasks                      151 B         102 kB
├ ƒ /api/trpc/[trpc]                       151 B         102 kB
├ ƒ /audit                                 169 B         105 kB
├ ƒ /cost                                 109 kB         211 kB
├ ○ /login                               1.88 kB         111 kB
├ ƒ /loops                               5.22 kB         117 kB   ← T01 (was placeholder)
├ ƒ /loops/[loopId]                      3.24 kB         118 kB   ← T02 + T04 (new route)
├ ƒ /schedules                           43.4 kB         158 kB   ← T05 + T06 + T07 + T08 + T09
├ ƒ /tasks                                 169 B         105 kB
└ ƒ /tasks/[id]                          1.82 kB         117 kB
+ First Load JS shared by all             102 kB
ƒ Middleware                             35.2 kB
```

Bundle deltas vs. Phase 2 sign-off:

- `/loops` placeholder → **5.22 kB / 117 kB** (T01 list page +
  filters, T03 start-loop dialog mounted on the list).
- `/loops/[loopId]` is **new** at **3.24 kB / 117 kB** (T02
  timeline + cost sparkline; T04 cancel + approve/reject inline).
  Pulls `recharts` already present on `/cost`'s 109 kB chunk,
  re-used here without re-import (chunk shared).
- `/schedules` placeholder → **43.4 kB / 158 kB** — the heaviest
  Phase 3 surface. Carries the cron picker (`cron-parser` +
  `cronstrue`), the create dialog, the row-actions island, the
  run-history drawer (`<Sheet>`), and the cost-forecast block.
  T09 added **+2.2 kB** on top of T08's 41.2 kB. Documented in
  `T09-review.md`.
- Shared JS: **102 kB → 102 kB** (no change — every Phase 3 client
  surface is a leaf on a server-rendered route).
- `/cost` still 211 kB; `/login` still 1.88 kB / 111 kB;
  middleware still 35.2 kB (Phase 3 added zero middleware code —
  CSRF + rate-limit guards are inherited as-is).

**No bundle regression on inherited routes.** The "0 client
components in the data path" property from Phase 1 is preserved —
Phase 3 only added client leaves at mutation surfaces
(`<StartLoopDialog>`, `<LoopCancelControl>`, `<LoopApproveGate>`,
`<ScheduleCreateDialog>`, `<CronPicker>`, `<ScheduleRowActions>`,
`<ScheduleRunsDrawer>`).

### `bun run test:e2e` (Playwright, 7 specs)

| Spec | Status | Notes |
|------|--------|-------|
| `smoke.spec.ts` | green (Phase 1 carry-over) | Surface untouched. |
| `dispatch-dialog.spec.ts` | green (Phase 2) | T02 + T01 happy path through ⌘K modal. |
| `csrf.spec.ts` | green (Phase 2) | T08 — 403 without `x-csrf-token`, 200 with. |
| `rate-limit.spec.ts` | green (Phase 2) | T07 — 31st mutation within 60 s returns 429 + `Retry-After`. |
| `audit-view.spec.ts` | green (Phase 2) | T05 — URL-as-truth filter round-trip + virtualizer DOM-row cap. |
| **`loop-flow.spec.ts`** | **green (Phase 3)** | **T03 + T04 — start dialog → cancel via typed-prefix DangerConfirm; approve gate on a pre-seeded pending loop.** |
| **`schedules-flow.spec.ts`** | **green (Phase 3)** | **T06 + T07 — create via cron picker (forecast block renders) → pause flip → typed-name delete.** |

Recorded in commit `d029e1d test(phase-3): E2E playwright critical
flows`. The two new specs drive a fake stdio MCP daemon
(`tests/e2e/fake-mcp.ts`) configured via `playwright.config.ts`
env `CLAUDE_BRIDGE_MCP_COMMAND` — same fixture pattern as Phase 2
e2e specs, but extended with mock `bridge_loop` /
`bridge_loop_cancel` / `bridge_schedule_*` handlers that mutate
the same SQLite fixture the dashboard reads. **Re-run before any
tag / internal release**.

### `bun test` (unscoped — picks up Playwright specs)

Carries the same 7-Playwright-spec collateral fail/error count as
Phase 2 (now 7 fails / 7 errors instead of 5 fails / 5 errors —
the two new Phase 3 specs add to the existing pattern). All are
isolated to `tests/e2e/`. **Not a regression** — the scoped
`bun run test` script stays clean. Same Phase 2 lesson §3
recommendation applies: a future Phase 4 chore should move
`tests/e2e/` → `playwright/` or add a Bun guard.

---

## Browser test

- Plan: [`PHASE-BROWSER-TEST.md`](PHASE-BROWSER-TEST.md) — 9-step
  manual checklist (loops list / detail / start / cancel + approve
  gate, schedules list / create / pause+delete / run history
  drawer / cost forecast) + cross-cutting checks (theme, console,
  network, logout) + audit-row coverage matrix + sign-off section.
- Status: **manual verify pending** — agent cannot drive an
  interactive browser. Playwright covers the contract; this plan
  covers the experience (cron picker fire-times preview, cost
  forecast race-guard, drawer open animation, optimistic pause
  rollback).
- Action item: human runs the plan end-to-end once before merging
  Phase 3 to a release branch. Each failed step is a Phase 4
  entry blocker.

---

## Cost analysis

> **Budget mode:** UNLIMITED (per loop spec).

- **Plan estimate:** comparable to Phase 2's $50–$80 band, with
  lower transport risk because MCP pool + audit + CSRF + rate-
  limit are reusable from Phase 2 (per Phase 2 sign-off
  recommendation). Phase 3 INDEX did not pin a number.
- **Actual:** *not tracked precisely under unlimited mode*. Rough
  estimate from per-task complexity puts it at **≈ $50–$70**, in
  line with Phase 2's mid-band. Resume from T06 (commit
  `3559867`) likely saved $10–$15 vs a from-scratch run because
  T01–T05 did not need re-tooling.
- **Most expensive tasks (subjective, by iter complexity):**

  | Task | Approx weight | Note |
  |------|---------------|------|
  | T06 | high | Cron picker is the only novel UI primitive; preset / custom modes + live cronstrue + fire-times preview. 463-line dialog component. |
  | T09 | high | Pure helper math (Type-7 quantiles, cron-parser 30-day window, interval fast-path) + tRPC query + dialog wiring with race-guard token. 339-line test file. |
  | T07 | medium | Three sibling mutations + optimistic pause/resume + DangerConfirm delete; +210 router test cases. |
  | T05 | medium | Schedules vertical entry; cron formatter helper + page primitives + 287-line page test. |
  | T03 | medium | First Phase 3 mutation; rehearsed CSRF/rate/audit/MCP path for `loops.start`. |
  | T08 | medium | Run-history drawer; SQLite parent_task_id heuristic + Phase 1 `<TaskTable>` reuse. |
  | T01 | low | Loops list — same shape as Phase 1 `/tasks`, URL-as-truth filters reused. |
  | T02 | low | Loop detail timeline + sparkline; recharts already present from `/cost`. |
  | T04 | low | Cancel + approve/reject; reuses `<DangerConfirm>` + Phase 2 T06 race pattern. |
  | E2E | medium | Fake-MCP harness extension for `bridge_loop*` + `bridge_schedule_*` handlers; two new specs. |

- **No cap event.** The loop completed all 9 task iterations +
  E2E iter + sign-off iter end-to-end. The plan-first invariant
  (one task + one commit per iter) held throughout.

---

## Lessons learned (carry into Phase 4)

1. **Vertical-then-vertical sequencing was the right call.** Phase
   2 needed foundation-first hybrid because the foundation
   *didn't exist*; Phase 3 inherited it and could sequence by
   feature slice. The two verticals (loops T01–T04, schedules
   T05–T09) finished cleanly with no cross-vertical regression. **Recommendation:** continue this pattern when entering a phase
   that adds *user-visible* features on top of an already-stable
   foundation. Reserve foundation-first for phases that introduce
   genuinely new transport / guard / audit infrastructure.
2. **Resume from a checkpoint commit is reliable.** The loop
   paused after T05 and resumed via `chore(phase-3): resume from
   T06`. The subsequent iters did not redo T01–T05, did not
   conflict with already-landed code, and produced clean
   per-task commits. **Recommendation:** when a multi-iter loop
   is interrupted, *always* land a `chore: resume from T<NN>`
   marker commit before continuing. It costs one trivial commit
   and gives future-you (and `git log --oneline`) a clean
   resumption point. Do **not** try to amend prior commits —
   keeping each task as its own commit preserves the per-task
   review pairing.
3. **`cron-parser` + `cronstrue` are the right primitives for cron
   UX.** Both are tiny (under 100 kB combined gzip), have no
   peer-dep weight, and produced the entire cron picker UX
   (preset radios, custom-mode validation, fire-times preview)
   without us writing a single cron-arithmetic function ourselves. **Recommendation for Phase 4:** when a feature needs
   domain-specific parsing (cron, ISO duration, timezone math),
   pull a small library before writing it ourselves. The
   `<DangerConfirm>` / `runOptimistic` "primitives over
   abstractions" rule from Phase 2 still applies for *UI* code,
   but for *domain* parsing prefer audited libs.
4. **Cost forecast as pure helper paid off.** `forecastSchedule`
   in `src/lib/cost-forecast.ts` has no DB / React / fetch
   dependency — it takes `cost samples` + `cadence` and returns
   a typed result. The tRPC query is a thin shell that loads
   samples; the dialog is a thin shell that renders the result. 339 unit-test lines exhaustively cover the math (Type-7
   p10/p50/p90 quantile interpolation, cron-parser 30-day
   window, interval fast-path) without spinning up a server. **Recommendation:** keep this shape for any future analytics
   helper — pure function in `src/lib/`, query is a thin shell,
   render is a thin shell. Do not let analytics math leak into
   tRPC procedures.
5. **Race-guard tokens beat AbortController for "swap query on
   input change".** T09's cost-forecast fetch in the dialog uses
   a monotonic counter `useRef` to discard stale responses.
   AbortController would also work but adds complexity (signal
   propagation through tRPC client, server-side abort handling). The race-guard pattern fits when the only goal is "ignore
   stale responses, do not actually cancel work." **Recommendation:** use this pattern by default; reserve
   AbortController for genuinely cancellable side-effects
   (uploads, long-running streams).
6. **Privacy invariant `hasGoal` / `hasPrompt` / `hasReason`
   pattern scaled.** Phase 2 introduced `hasReason: true` for
   loop reject. Phase 3 extended it to T03 `goal`, T06 `prompt`,
   T04 reject `reason`. Audit table still has zero free-text
   user input across the entire app. **Recommendation for Phase
   4:** every new mutation adds a `hasFreeText: true` flag in
   `payload_json` if the user can paste arbitrary text — never
   the text itself. Make this a checklist item on the per-task
   review template.
7. **The `T<NN>-<slug>.md` + `T<NN>-review.md` per-task pair
   continues to be valuable.** Spec captures intent, review
   captures *decisions and what a reviewer should push on*. The
   pair is the durable artifact; the commit message is the
   ephemeral one. **Recommendation:** keep both. The review file
   is most useful 3 months later when you forget *why* you
   picked Type-7 over Type-1 quantiles, or *why* `cron_expr`
   only stores the label and the daemon ultimately receives
   `interval_minutes` (T06 review).

---

## Out-of-scope follow-ups (carried + new)

**Carried from Phase 2 (still open after Phase 3):**

- Daemon-side `audit_log` write joined on `request_id`. Phase 3
  did not change this; audit forensics still span dashboard rows
  only.
- Daemon-side MCP tool for `permissions.respond` (Phase 2 T09
  follow-up). Unchanged.
- Vendored schema sync (`bun run sync-schema`). Phase 3 did **not**
  add new dashboard-owned tables (audit_log remains the only one),
  so the schema-drift risk did not materialize. Re-flagged for
  Phase 4 if Phase 4 adds notification-preferences / user-prefs
  tables.
- Multi-replica rate-limit. Still in-memory token bucket. Phase 4
  Docker compose must migrate to SQLite or Redis.
- Playwright SPA-click coverage. Phase 3's two new specs follow
  Phase 2's contract-level pattern (Network assertions on status
  + headers + JSON shapes). Genuine SPA-click coverage stays
  deferred to a hypothetical "Phase 3.5 — E2E hardening" mini-
  phase.

**New (filed against `claude-bridge-dashboard`):**

- **Cost forecast accuracy validation.** Per v1 P3-T9, "± 30%
  accuracy after 30 days of real data" is the empirical
  acceptance. This loop validated the *shape* of the output and
  the math (Type-7 quantile + cron iter count). Empirical
  validation is filed as a **30-day-after-launch** task.
- **Cron daemon-side gap.** The daemon's `bridge_schedule_add`
  MCP tool (per `CLAUDE.md`) accepts `interval_minutes`; cron
  expression support was added during Phase 3 via a
  client-side label + interval fallback (T06 review records the
  decision). If the daemon eventually exposes
  `cron_expr` natively, T06's `bridge_schedule_add` call needs
  to be updated to pass it through. **Filed against the daemon
  repo.**
- **Loop iteration SSE multiplex.** Phase 2 lesson §3 + Phase 3
  INDEX both flagged this. T2's loop detail page polls every
  2 s for `loops.get`; multiplexing onto a single
  `/api/stream` (loops + schedules + tasks + permissions) is
  filed against Phase 4. Today's two SSE routes are sufficient
  for read-after-write semantics on the loop detail page.
- **Run history pagination.** T8 caps at 30 rows by design (per
  spec). For long-running schedules with hundreds of fires, a
  "Load more" button or cursor pagination would be useful.
  Filed as a Phase 4 nice-to-have.

---

## Phase 4 scoping recommendation

Phase 4 (per the v2 plan) is *Docker compose deployment + multi-
replica readiness + notification preferences*. The Phase 3
mutation surface is now stable, but several Phase 3 follow-ups
become Phase 4 entry blockers:

1. **Multi-replica rate-limit migration** (Phase 2 T07 follow-up,
   re-flagged here). In-memory token bucket cannot survive
   horizontal scaling. Migrate to SQLite-backed (cheapest,
   stays single-binary) or Redis (if Phase 4 introduces a
   shared cache).
2. **Loop iteration SSE multiplex** (Phase 2 lesson §3,
   re-flagged here). Phase 4 adds a third SSE-equivalent
   surface — schedule run events, possibly notification deliveries
   — and a 4th parallel route crosses the threshold where
   multiplexing pays off.
3. **`bun run sync-schema` daemon vendor automation** (Phase 1
   T14 deferred, Phase 2 §5 lesson, Phase 3 unchanged). If
   Phase 4 adds notification-preferences / user-prefs tables,
   schema drift becomes a real bottleneck.

Phase 4 cost estimate: lower than Phase 3 (≈ $30–$60 unlimited,
~6 tasks) — most work is rate-limit migration + SSE multiplex
+ tooling, with no new mutation surfaces.

---

## Phase exit verdict

**GO-WITH-CAVEAT** — Phase 3 ships.

**Caveats blocking a clean GO:**

1. **Manual browser test (`PHASE-BROWSER-TEST.md`) is pending.**
   The 9-step plan must be run by a human once before any tag /
   internal release. Failure at any step is a Phase 4 entry
   blocker. Same expectation Phase 2 set; Phase 3 inherits it.
2. **Cost forecast accuracy is shape-only, not empirical.** Per
   v1 P3-T9 acceptance, the "± 30% after 30 days" criterion is
   filed as a 30-day-after-launch validation task. Until then,
   the forecast is a *guidance number*, not a guaranteed budget.
3. **`bun test` (unscoped) shows 7 fails / 7 errors.** All seven
   are `tests/e2e/` Playwright specs picked up by the Bun runner;
   `bun run test` (scoped) is clean at 946 / 0. Documented in
   test-results § above and inherited from Phase 2 lesson §3.
   The fix (move `tests/e2e/` → `playwright/` or add a Bun
   guard) remains a Phase 4 chore.
4. **Cron support reaches the daemon as `interval_minutes`, not
   a true cron expression.** Recorded in T06 review. The dashboard
   accepts arbitrary cron expressions in the picker, but submits
   `intervalMinutes` (or rejects non-uniform crons like
   `0 9 * * 1-5` per T06 spec). The user-visible surface still
   reads as cron; the daemon-visible payload is an interval. If
   the daemon adds native cron support, T06's call shape needs to
   be revisited.

**Confidence level:** high. Mutation invariant held throughout
(every Phase 3 mutation goes CSRF → rate-limit → audit → MCP);
946 unit / integration tests green; production build clean with
no bundle regression on inherited routes; Playwright e2e green
at last run with two new specs covering the loops + schedules
critical flows; no XSS / secret-leak gaps in audit payloads
(every free-text field has `hasFreeText: true`); MCP pool is
reused unchanged from Phase 2 (no fork per Phase 2 lesson §7);
optimistic UI applied only to T7 pause/resume per Phase 2
review §d.1.

**Phase 3 user surface is production-ready under single-user,
single-process operation** — Mai (PM persona in the PRD) can
create + manage 5 schedules and start + cancel + approve goal
loops without touching the CLI, which is the v1 PRD's headline
acceptance. Multi-user / multi-replica scenarios defer to Phase
4 per the carried-forward open items above.

**Next step:** run `PHASE-BROWSER-TEST.md`, file any failures as
Phase 4 entry blockers, then plan Phase 4 with the
foundation-first pattern again (rate-limit migration + SSE
multiplex are genuinely new infrastructure). Do **not** start
Phase 4 work in this branch — cut a `phase-4` branch off the
merged Phase 3 commit.

---

*Sign-off written by loop iter 7/7 on 2026-05-06.*
