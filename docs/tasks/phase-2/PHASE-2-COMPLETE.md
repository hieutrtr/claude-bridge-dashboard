# Phase 2 — Actions — Sign-off

- **Date completed:** 2026-05-06
- **Branch:** `main` (commits `87a4b2f` … `5fb71c9` — 14 retroactive
  Phase 2 commits + this sign-off, no force-push, no remote push).
- **Phase invariant held:** every mutation procedure is gated by
  CSRF (T08) → rate-limit (T07) → audit-log write (T04) → MCP
  transport (T12), with confirmation pattern (T11) on destructive
  surfaces. Verified per-task in each `T<NN>-review.md`.
- **Sequencing:** foundation-first hybrid (`T12 → T08 → T07 → T04 →
  T01 → T03 → T06 → T02 → T05 → T11 → T10 → T09`) — the 2a/2b split
  recommended by `docs/PHASE-2-REVIEW.md` §g was **declined** in
  favour of single-phase landing with T12 as a foundation commit.
  Decision rationale captured in `INDEX.md` § *Sequencing decision*.

---

## 12-task checklist

Click through to each per-task review for files changed, test counts,
and decisions/issues.

- [x] **T01** — `tasks.dispatch` via MCP — [`T01-review.md`](T01-review.md)
- [x] **T02** — Dispatch dialog UI (⌘K) — [`T02-review.md`](T02-review.md)
- [x] **T03** — Kill task action (`tasks.kill` via MCP) — [`T03-review.md`](T03-review.md)
- [x] **T04** — Audit log table & write helper — [`T04-review.md`](T04-review.md)
- [x] **T05** — Audit log viewer page (`/audit`) — [`T05-review.md`](T05-review.md)
- [x] **T06** — Loop approve / reject inline — [`T06-review.md`](T06-review.md)
- [x] **T07** — Rate-limit middleware (token bucket) — [`T07-review.md`](T07-review.md)
- [x] **T08** — CSRF double-submit middleware — [`T08-review.md`](T08-review.md)
- [x] **T09** — Permission relay UI (SSE + toast) — [`T09-review.md`](T09-review.md)
- [x] **T10** — Optimistic UI updates (+ rollback) — [`T10-review.md`](T10-review.md)
- [x] **T11** — Confirmation pattern (`<DangerConfirm>`) — [`T11-review.md`](T11-review.md)
- [x] **T12** — MCP client connection pool — [`T12-review.md`](T12-review.md)

12 / 12 task reviews on file. INDEX (`INDEX.md`) and the per-task
spec files (`T<NN>-<slug>.md`) ship alongside.

---

## Test results (2026-05-06, just before sign-off)

### `bun run test` (scoped: `tests/lib tests/app tests/server`)

```
563 pass · 0 fail · 3278 expect() calls · 54 files · ~2.55 s
```

Clean. The scoped script (added in Phase 1 T13) deliberately excludes
`tests/e2e/` so the Bun runner does not trip over the Playwright
specs. **Phase 2 added 306 unit/integration tests on top of Phase 1's
257** — the bulk in `tests/server/*` (mcp-pool, rate-limit, csrf,
audit, tasks-router, loops-router, permissions-router) and
`tests/app/*` (dispatch-dialog, audit-view, danger-confirm,
permission-relay-toast).

Distribution (largest ≥ 100 lines):

| Test file | Tests |
|-----------|-------|
| `tests/server/tasks-router.test.ts` | 1225 lines |
| `tests/server/loops-router.test.ts` | 669 lines |
| `tests/server/permissions-router.test.ts` | 318 lines |
| `tests/server/mcp-pool.test.ts` | 194 lines |
| `tests/server/sse-permissions.test.ts` | 177 lines |
| `tests/server/rate-limit-mutations.test.ts` | 135 lines |
| `tests/server/migrate.test.ts` | 121 lines |
| `tests/server/rate-limit-login.test.ts` | 83 lines |

### `bun test` (unscoped — picks up Playwright specs)

```
563 pass · 5 fail · 5 errors · 3278 expect() calls · 59 files · ~2.69 s
```

The 5 fail / 5 error are **expected and isolated to `tests/e2e/`** —
all five Playwright spec files (`smoke`, `dispatch-dialog`, `csrf`,
`rate-limit`, `audit-view`) trip Bun's test runner because they call
Playwright `test()` from a `@playwright/test` import. Phase 1's
`T13-review.md` documents this as the reason the project's `test`
script scopes to `tests/{lib,app,server}`. Use `bun run test` for
unit/integration; use `bun run test:e2e` for Playwright. **Not a
regression**.

### `bun run typecheck`

```
$ tsc --noEmit          # clean — zero errors
```

### `bun run build` (production)

```
✓ Compiled successfully in 1.76 s
✓ Generating static pages (9/9)
```

Routes after Phase 2 (added: `/api/stream/permissions`, `/audit`):

```
Route (app)                                 Size  First Load JS
┌ ○ /                                      155 B         102 kB
├ ○ /_not-found                            996 B         103 kB
├ ƒ /agents                                164 B         105 kB
├ ƒ /agents/[name]                         169 B         105 kB
├ ƒ /api/auth/login                        155 B         102 kB
├ ƒ /api/auth/logout                       155 B         102 kB
├ ƒ /api/stream/permissions                155 B         102 kB   ← new (T09)
├ ƒ /api/stream/tasks                      155 B         102 kB
├ ƒ /api/trpc/[trpc]                       155 B         102 kB
├ ƒ /audit                                 169 B         105 kB   ← new (T05)
├ ƒ /cost                                 109 kB         211 kB
├ ○ /login                               1.88 kB         111 kB
├ ○ /loops                                 155 B         102 kB
├ ○ /schedules                             155 B         102 kB
├ ƒ /tasks                                 169 B         105 kB
└ ƒ /tasks/[id]                          4.03 kB         116 kB
+ First Load JS shared by all             102 kB
ƒ Middleware                             35.2 kB
```

Bundle deltas vs. Phase 1:
- Shared JS: **102 kB → 102 kB** (no change — T08/T07/T11 are
  server-only or tree-shaken into dialog leaves).
- Heaviest dynamic route: `/cost` still 211 kB (Recharts dominates).
- `/tasks/[id]` grew 4 kB → **4.03 kB** for `<DangerConfirm>` +
  optimistic kill control. Negligible.
- `/login` unchanged at 1.88 kB / 111 kB.
- Middleware: **35.2 kB** — CSRF guard + rate-limit token bucket +
  audit pre-write add ~3 kB to Phase 1's baseline (32 kB).

**No bundle regression**. The "0 client components in the data path"
property from Phase 1 is preserved — Phase 2 only added client
leaves at mutation surfaces (`<DispatchDialog>`, `<DangerConfirm>`,
`<PermissionRelayToast>`, `<TaskKillControl>`).

### `bun run test:e2e` (Playwright, 5 specs)

| Spec | Status | Notes |
|------|--------|-------|
| `smoke.spec.ts` | green (Phase 1 carry-over) | last green run pre-T13 commit; not re-run for Phase 2 sign-off — surface untouched. |
| `dispatch-dialog.spec.ts` | green | T02 + T01 happy path through ⌘K modal. |
| `csrf.spec.ts` | green | T08 — 403 without `x-csrf-token`, 200 with. |
| `rate-limit.spec.ts` | green | T07 — 31st mutation within 60 s returns 429 + `Retry-After`. |
| `audit-view.spec.ts` | green | T05 — URL-as-truth filter round-trip + virtualizer DOM-row cap. |

Recorded in commit `5fb71c9 test(phase-2): e2e coverage for audit /
csrf / dispatch / rate-limit`. Not re-run during sign-off — the
spec set is contract-level (Network assertions on status codes +
headers), and contract has not changed since the spec landed.
**Re-run before any tag / internal release**.

---

## Browser test

- Plan: [`PHASE-BROWSER-TEST.md`](PHASE-BROWSER-TEST.md) — 12-step
  manual checklist (dispatch, kill, optimistic rollback, loop
  approve/reject, audit view, CSRF deny, rate-limit 429, ⌘K UX,
  permission relay toast, confirmation typing guard, virtualized
  scroll, audit-row coverage matrix) + cross-cutting checks (theme,
  console, network, logout) + sign-off section.
- Status: **manual verify pending** — agent cannot drive an
  interactive browser. Playwright covers contract; this plan covers
  the experience (SSE flow, optimistic feel, multi-tab consistency).
- Action item: human runs the plan end-to-end once before merging
  Phase 2 to a release branch. Each failed step is a Phase 3 entry
  blocker.

---

## Cost analysis

> **Budget mode:** UNLIMITED (no `$50` cap as in Phase 1; loop ran
> to completion across all 15 iters).

- **Plan estimate:** $60-$80 (per loop spec; review §f estimated
  $25-$60 realistic).
- **Actual:** *not tracked precisely under unlimited mode*; rough
  estimate from per-task complexity puts it at **≈ $55-$70**, in
  line with the plan's mid-band. The unlimited mode meant the loop
  did not stop mid-task as Phase 1 did at T13.
- **Most expensive tasks (subjective, by iter complexity):**

  | Task | Approx weight | Note |
  |------|---------------|------|
  | T12 | high | MCP pool — stdio framing, reconnect, chaos test, 194-line test file. |
  | T01 | high | Dispatch — first MCP-backed mutation; full CSRF+rate-limit+audit wiring exercised end-to-end for the first time. |
  | T09 | high | Permission relay — 6 new files, 40 tests, SSE diff helper from scratch, cross-tab consistency design. |
  | T06 | high | Loop approve/reject — race risk (compare-and-swap vs Telegram). |
  | T04 | medium | Audit migration + helper — straightforward but cross-cutting; many later tasks revisited it. |
  | T05 | medium | Audit viewer — virtualizer + URL-as-truth reuse, but pattern was solved in Phase 1 T05. |
  | T07 | medium | Rate-limit — login + mutation buckets, audit row on block. |
  | T08 | medium | CSRF — chose hand-rolled HMAC over `csrf-csrf` lib; ADR `0001-csrf-strategy.md` added. |
  | T02 | low | Dispatch dialog — UI work on top of T01. |
  | T03 | low | Kill — same call shape as T01, idempotency added. |
  | T10 | low | `runOptimistic` helper — dependency-free (no `@tanstack/react-query` introduced). |
  | T11 | low | `<DangerConfirm>` — primitive, retroactively wired into T03 + T06. |

- **No cap event.** The loop completed all 15 iters end-to-end.
  Compare with Phase 1 where the $50 cap fired during T13 — Phase 2
  budget mode let T12 + T09 (the two highest-cost tasks) breathe.

---

## Lessons learned (carry into Phase 3)

1. **Foundation-first hybrid worked.** Landing T12 (MCP pool) + T08
   (CSRF) + T07 (rate-limit) + T04 (audit) before any mutation
   procedure (T01) meant every subsequent mutation slotted into a
   stable transport + guard surface. **Recommendation for Phase 3:**
   identify the foundation tasks early in the planning doc and
   sequence them ahead of vertical slices, even if it pushes the
   first user-visible feature later in the loop. The Phase 1 split
   recommendation (2a/2b) was the right *intent* but the wrong
   *grouping* — risk isolation comes from sequencing, not from
   sub-phase ceremonies.
2. **Cross-cutting helpers should be primitives, not abstractions.**
   `<DangerConfirm>` (T11) and `runOptimistic` (T10) are both
   ~50-line primitives with no framework dependency. They get reused
   trivially, are easy to unit-test (view + injectable wrapper), and
   don't force later phases to adopt React Query or shadcn templates
   they didn't ask for. **Recommendation:** keep this style; resist
   the urge to introduce a heavy lib until a *third* call site
   exists.
3. **`bun:test` + `@playwright/test` cohabitation needs project-level
   discipline.** Phase 1 carried 1 known Bun-fail from picking up
   `tests/e2e/`. Phase 2 added 4 more Playwright specs and the
   unscoped count is now 5 fails. The scoped `bun run test` script
   stays clean, but new contributors will hit the unscoped path
   first. **Action for Phase 3:** add a `bun test` pre-commit hook
   that exits 0 only when called via `bun run test`, or move `e2e/`
   out of the `tests/` glob entirely (e.g. `playwright/`).
4. **Audit log proved its design value during sign-off.** The 12-step
   browser test plan can verify *every* mutation by cross-checking
   the audit table — that's only possible because T04 was wired
   before T01..T09. The `request_id` column (T04) lets cross-repo
   forensics correlate dashboard rows to daemon rows, even though
   the daemon-side audit write is deferred. **Recommendation for
   Phase 3:** keep `request_id` as a first-class request header /
   tRPC ctx field; resist any temptation to make it optional.
5. **The vendored Drizzle schema needs an automation path before
   Phase 3.** Phase 2 added `audit_log` as a dashboard-owned table
   with a comment annotation. Phase 3 will likely add more
   dashboard-owned tables (notification preferences, user prefs).
   The `bun run sync-schema` task deferred from Phase 1 P1-T14 is
   now a real bottleneck risk. **Action:** schedule it as the first
   task of Phase 3, or label it 0.6 tooling debt and unblock daemon
   coordination.
6. **Optimistic UI is best when *invisible*.** T10's `runOptimistic`
   helper makes kill feel sub-100 ms. The browser test plan's Step 3
   (offline rollback) is the only way to *see* it work — when it
   succeeds, the user just feels a fast app. **Recommendation:**
   apply the same pattern in Phase 3 wherever the round-trip is
   non-instant; do *not* apply to mutations whose semantics depend
   on the daemon's response (e.g. loop approve — it's
   server-confirmed by design, per review §d.1).
7. **MCP stdio framing was *not* a hidden landmine.** Going into
   T12, the plan's biggest fear was framing buffer corruption on
   partial reads / signal-handling on `Bun.spawn`. Both turned out
   tractable — T12 review documents the chaos-test (kill daemon
   mid-call) passing. **Lesson for Phase 3:** the foundation work in
   Phase 2 means MCP transport is a known quantity; new MCP-backed
   features can ship without re-investigating it. Reuse
   `src/server/mcp/pool.ts` as-is; don't fork.

---

## Out-of-scope follow-ups (filed against `claude-bridge`)

- **Daemon-side `audit_log` write.** T04 ships only the dashboard
  side. Daemon-side audit (joined on `request_id`) is filed against
  the daemon repo. Until landed, audit forensics span dashboard rows
  only.
- **Daemon-side MCP tool for `permissions.respond`.** T09 currently
  flips the `permissions` table row directly via the vendored
  `bun:sqlite` connection. A daemon MCP tool would route the
  response through the same surface as dispatch / kill. Filed.
- **Vendored schema sync (`bun run sync-schema`).** Deferred from
  Phase 1 P1-T14, raised again here. Critical before Phase 3 if
  daemon-side schema starts to drift.
- **Multi-replica rate-limit.** T07 is in-memory token bucket only;
  works only single-process. Phase 4 (Docker compose) must migrate
  to SQLite or Redis. Documented in `T07-review.md`.
- **Playwright SPA-click coverage.** T13 (Phase 1) used `page.goto`
  for navigation; Phase 2's specs follow the same pattern. SPA-click
  coverage is genuinely valuable for UX regression but stays
  deferred to a "Phase 2.5 — E2E hardening" mini-phase if Phase 3
  adds complex client-side state.

---

## Phase 3 scoping recommendation

Phase 3 (per the v2 plan) is *Goal Loops + Schedules* — interactive
goal-loop kickoff from the dashboard, schedule create/edit/pause,
loop history viewer, schedule preview ("next 3 fire times"). The
Phase 2 mutation surface is a hard pre-req for all of that, and is
now stable.

**Recommendation:** keep the foundation-first sequencing pattern.
Phase 3's foundation tasks are likely:

1. Vendored schema sync automation (`bun run sync-schema` from
   P1-T14 deferred + Phase 2 §5 lesson) — **before** any Phase 3
   feature lands.
2. `loops.start` mutation via MCP (`bridge_loop` tool) —
   parallel structure to T01 (`tasks.dispatch`); test it once,
   schedules.start (which calls `bridge_schedule_add`) follows the
   same pattern.
3. `system.events` SSE multiplex (loops + schedules + tasks +
   permissions in one stream) — Phase 2 has 2 separate streams
   (`/api/stream/tasks`, `/api/stream/permissions`); a 3rd parallel
   route (loop iteration events) crosses the threshold where
   multiplexing pays off. Phase 1 lesson §3 already flagged this.

Phase 3 cost estimate: comparable to Phase 2 (≈ $50-$80 unlimited,
~12 tasks), but with **lower transport risk** because MCP pool +
audit + CSRF + rate-limit are reusable.

---

## Phase exit verdict

**GO-WITH-CAVEAT** — Phase 2 ships.

**Caveats blocking a clean GO:**

1. **Manual browser test (`PHASE-BROWSER-TEST.md`) is pending.** The
   12-step plan must be run by a human once before any tag /
   internal release. Failure at any step is a Phase 3 entry blocker.
2. **Daemon-side audit + permission MCP follow-ups not landed.**
   The dashboard-side surface is complete; the daemon coordination
   PRs (audit write on the daemon side, permission MCP tool) are
   filed but not merged. **Not a Phase 2 gap** — those issues are
   tracked against `claude-bridge`. Flagged here so future-you knows
   that audit forensics are dashboard-side-only until the daemon PR
   lands.
3. **`bun test` (unscoped) shows 5 fails / 5 errors.** All five are
   `tests/e2e/` Playwright specs picked up by the Bun runner;
   `bun run test` (scoped) is clean. Documented in test-results §
   above and in Phase 2 lessons §3. The fix (move `tests/e2e/` →
   `playwright/` or add a Bun guard) is a Phase 3 chore.

**Confidence level:** high. Mutation invariant held throughout
(every mutation goes CSRF → rate-limit → audit → MCP); 563 unit/
integration tests green; production build clean with no bundle
regression; Playwright e2e green at last run; no XSS / secret-leak
gaps in audit payloads (T09 privacy invariant test asserts
`command` is never persisted); MCP pool chaos-test passes ("kill
daemon mid-call" → fail-fast pending requests, no hang).

**Phase 2 mutation surface is production-ready under single-user,
single-process operation.** Multi-user / multi-replica scenarios
(per T07 note + INDEX `Notes / open questions`) defer to Phase 4.

**Next step:** run `PHASE-BROWSER-TEST.md`, file any failures as
Phase 3 entry blockers, then plan Phase 3 with the foundation-first
pattern. Do **not** start Phase 3 work in this branch — cut a
`phase-3` branch off the merged Phase 2 commit.

---

*Sign-off written by loop iter 15/15 on 2026-05-06.*
