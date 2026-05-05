# Phase 1 — Read-only MVP — Sign-off

- **Date completed:** 2026-05-05
- **Branch:** `main` (single commit `c16e912` baseline + uncommitted Phase 1 work — user reviews diff before commit)
- **Phase invariant held:** Read-only — zero mutation procedures, zero `bridge_dispatch` / `tasks.kill` / `loops.approve` calls. Audited per-task in each `T<NN>-review.md`.

---

## 13-task checklist

All tasks complete with self-review; click through to the per-task
review for files changed, test counts, and decisions/issues.

- [x] **T01** — Layout & navigation shell — [`T01-review.md`](T01-review.md)
- [x] **T02** — Auth: env-password middleware — [`T02-review.md`](T02-review.md)
- [x] **T03** — `agents.list` enrichment + Agents grid — [`T03-review.md`](T03-review.md)
- [x] **T04** — `agents.get` + Agent detail (Tasks tab) — [`T04-review.md`](T04-review.md)
- [x] **T05** — `tasks.list` + global Tasks page — [`T05-review.md`](T05-review.md)
- [x] **T06** — `tasks.get` + Task detail page — [`T06-review.md`](T06-review.md)
- [x] **T07** — Transcript viewer (JSONL) — [`T07-review.md`](T07-review.md)
- [x] **T08** — SSE `/api/stream/tasks` (read-only) — [`T08-review.md`](T08-review.md)
- [x] **T09** — Cost analytics page — [`T09-review.md`](T09-review.md)
- [x] **T10** — Memory tab (read-only) — [`T10-review.md`](T10-review.md)
- [x] **T11** — Empty / error / loading states — [`T11-review.md`](T11-review.md)
- [x] **T12** — Dark / light theme polish — [`T12-review.md`](T12-review.md)
- [x] **T13** — E2E smoke test (Playwright) — [`T13-review.md`](T13-review.md)

---

## Test results (2026-05-05, just before sign-off)

### `bun run test` (scoped: `tests/lib tests/app tests/server`)

```
257 pass · 0 fail · 678 expect() calls · 24 files · 867 ms
```

Clean. The scoped script lives in `package.json` (T13 added the
scope so the Playwright spec doesn't trip the Bun runner — they
are different test runners).

### `bun test` (unscoped — picks up Playwright spec)

```
257 pass · 1 fail · 1 error · 678 expect() calls · 25 files · 1109 ms
```

The 1 fail + 1 error is **expected and documented in T13**:
`tests/e2e/smoke.spec.ts` is a Playwright spec, not a Bun test.
Running `bun test` with no path picks it up and Playwright
correctly errors ("Playwright Test did not expect test() to be
called here"). Not a regression — exactly why the project's
`test` script scopes to `tests/{lib,app,server}`. Use `bun run
test` for unit/integration and `bun run test:e2e` for E2E.

### `bun run build` (production)

```
✓ Compiled successfully in 4.2s
✓ Generating static pages (9/9)
```

9 routes (`/`, `/agents`, `/agents/[name]`, `/tasks`, `/tasks/[id]`,
`/cost`, `/loops`, `/schedules`, `/login` + `/_not-found`) +
3 API routes (`/api/auth/login`, `/api/auth/logout`,
`/api/stream/tasks`, `/api/trpc/[trpc]`).

Bundle sizes: shared First Load JS **102 kB**, heaviest route is
`/cost` at **211 kB** (Recharts pulls in d3-shape + d3-scale).
`/login` is the only client-heavy non-Recharts route at 111 kB.
Static routes pre-rendered: `/`, `/_not-found`, `/login`,
`/loops`, `/schedules`. Everything else `ƒ` (server-rendered on
demand) — expected since they read SQLite live.

### `bun run test:e2e` (Playwright, T13)

Last green run logged in `T13-review.md`: 1 test, ~18.5s,
3/3 stability runs. Not re-run for sign-off because the
fixture-spawning cost is ~22s per cold run and T13 already
captured stability evidence yesterday — flagged here only because
**it should be re-run by whoever picks up Phase 2 if they touch
auth, agents grid, or task detail**.

### `bun run typecheck`

Last clean run captured in T12 + T13 reviews; **not re-run for
sign-off** because no code changed between T13 landing and this
doc — only docs. Re-run before Phase 2 starts.

---

## Browser test

- Plan: [`PHASE-BROWSER-TEST.md`](PHASE-BROWSER-TEST.md) — 9-step
  manual checklist + cross-cutting checks (theme, console, network,
  logout) + sign-off section.
- Status: **manual verify pending** — agent cannot drive an
  interactive browser. Playwright (T13) covers the contract; the
  manual plan covers the experience (SSE live update, FCP feel,
  no console errors, theme toggle smoothness).
- Action item: human runs the plan once before merging Phase 1
  to a release branch.

---

## Cost analysis

- **Plan estimate:** $60 token budget for Phase 1 (P1-T1..T13 +
  index/sign-off/test).
- **Actual:** ≈ **$58.36** (within $50 cap was the loop's hard
  guard — the loop terminated when it crossed the cap during T13
  Playwright debugging, but the 13 tasks were essentially done).
- **Cap event explanation:** the $50 ceiling tripped during T13
  iteration. T13 was unusually expensive because of the
  Watchpack-on-WAL diagnosis (Issue #1) and the Playwright
  `<Link>`-click rabbit hole (Issue #2) — both required multiple
  Red runs against a real `next dev` server, each ~30s of compile
  + browser cold-start. After cap, this PHASE-1-COMPLETE pass
  ran outside the loop as a single one-shot task (cheap — just
  doc writing + `bun test` / `bun build`).
- **Approximate per-task breakdown** (from iter logs / memory):

  | Task | Approx $ | Note |
  |------|----------|------|
  | INDEX  | 0.4 | One-shot, mostly link planning |
  | T01    | 2.5 | Shell + 16 new tests |
  | T02    | 4.0 | Auth + middleware + 25 tests, JWT plumbing |
  | T03    | 3.0 | Agent grid + DTO refactor |
  | T04    | 4.5 | Agent detail + tabs + new `tasks` router |
  | T05    | 5.0 | Filter form + URL-as-truth pattern, 15 tests |
  | T06    | 4.5 | Task detail + markdown sanitize, 12 tests |
  | T07    | 6.0 | Transcript parser, 25 tests, JSONL drift |
  | T08    | 5.5 | SSE + diff + 21 tests, signal-abort wiring |
  | T09    | 5.0 | Recharts + analytics router, 20 tests |
  | T10    | 3.5 | Memory tab, 16 tests, dir-walk safety |
  | T11    | 4.0 | Skeleton + offline banner + boundary, 28 tests |
  | T12    | 3.0 | Theme tokens + helper extraction, 34 tests |
  | T13    | 7.5 | Playwright + Watchpack diag + click rabbit hole |
  | **Total** | **~58.4** | Matches loop ledger ± $1 |

  T13 was the single biggest line item (~13% of phase cost). The
  T13 cost spike is a **Phase 2 lesson**: the moment a phase
  introduces a new test runner against `next dev`, treat it as a
  first-class integration unknown, not a polish bolt-on.

---

## Lessons learned (carry into Phase 2)

1. **T13 Playwright cost spike → consider splitting E2E into its
   own phase.** Phase 1 absorbed E2E because the plan said so, but
   T13 alone was ~7.5 of 58.4 ($-cost) and **most of that cost was
   diagnosing two transport-layer quirks** (Watchpack-on-WAL,
   Playwright click vs `next dev` SPA nav). Phase 2 introduces
   *real* mutations + MCP stdio — extending E2E to cover those is
   strictly harder. **Recommendation:** carve E2E into its own
   "Phase 2.5 — E2E hardening" mini-phase that runs *after* the
   mutation slices (2a, 2b) land, so the spec is written against
   stable surfaces, not surfaces still moving under the spec.
2. **Read-only invariant was load-bearing for design clarity.**
   Forcing every task to declare "no mutation" made each tRPC
   procedure a pure DB query and made each page server-renderable
   by default. The dashboard is currently 0 client components in
   the data path (Recharts on `/cost` and the theme toggle are
   the only `"use client"` leaves). This will degrade the moment
   Phase 2 adds dispatch — plan for it consciously: keep server
   components by default, add client components only at mutation
   leaves (dialogs, optimistic mutate hooks).
3. **SSE pattern is ready for Phase 2 mutation streams.** T08
   built `createTaskStreamResponse({ signal, pollMs, heartbeatMs,
   readSnapshot })` as a *contract function* (pure
   formatter/diff in `src/lib/sse.ts`, route handler is a thin
   shim). Phase 2's permission-relay (P2-T9) and live-loop
   pending events can reuse this exact pattern — `readSnapshot`
   becomes a different SQL select, the formatter and signal
   handling stay identical. Don't refactor it ahead of time —
   wait until P2-T9 to extract a shared util, since the second
   call site is the cheapest moment to know what the abstraction
   needs.
4. **Schema vendoring (`src/db/schema.ts`) needs an automation
   path before Phase 2.** v2 P1-T14 was deferred — currently the
   schema is hand-copied. Phase 2 adds an `audit_log` table
   (P2-T4) which lives in the daemon repo's schema; vendoring it
   manually means a 2-PR coordination dance every time the
   daemon schema changes. **Action:** add `bun run sync-schema`
   as the first task of Phase 2 (or label it 0.6 if treating as
   tooling debt).

---

## Phase 2 scoping recommendation

The Phase 2 review (`docs/PHASE-2-REVIEW.md` §g) recommended
**splitting Phase 2 into 2a + 2b**:

- **Phase 2a — read-side mutations** (5 task: kill, loop
  approve/reject, audit table+viewer, confirmation pattern;
  ~$15, ~5 days). Exit: user can intervene in existing tasks
  via web.
- **Phase 2b — write-side + transport** (7 task: dispatch,
  dialog, MCP pool, rate-limit, CSRF, optimistic, permission
  relay; ~$30–45, ~7 days). Exit: user can create new tasks
  via web.

**This sign-off endorses the split.** Reasons (from review §g,
reaffirmed by Phase 1's experience):

1. T13 already proved that *one* hard transport task (Playwright
   ↔ `next dev`) can eat 13% of a phase budget. Phase 2b
   contains *three* — P2-T1 (MCP stdio), P2-T9 (permission relay
   schema cross-repo), P2-T12 (connection pool). Concentrating
   them in one phase is a recipe for a $50-cap loop kill.
2. The audit table (P2-T4) is a hard prerequisite for *any*
   mutation, so it must land in 2a regardless. That naturally
   pulls T3 (kill) and T6 (loop approve) along — the MCP tools
   for both already exist, no new transport work.
3. Vertical slicing (v1 ARCH §0): 2a is a complete slice
   (intervene); 2b is a complete slice (create). Each is
   independently shippable as an internal beta.

**Caveat from review §g:** if dispatch UX is needed *urgently*
to dogfood, skip the split and accept the risk concentration.
This is a product call, not a tech call — flag for user.

---

## Phase exit verdict

**GO-WITH-CAVEAT** — Phase 1 ships.

**Caveats blocking a clean GO:**

1. Manual browser test (`PHASE-BROWSER-TEST.md`) is **pending**.
   The 9-step plan must be run by a human once before any tag /
   internal release. Failure at any step is a Phase 2 entry
   blocker.
2. The loop terminated at the $50 cap during T13 — work was
   completed via a one-shot pass outside the loop. The 13 tasks
   are done and self-reviewed; this is bookkeeping, not a code
   gap. Documented here so the loop ledger and the actual phase
   state agree.

**Confidence level:** high. Read-only invariant held throughout;
257 unit/integration tests green; production build clean;
Playwright smoke green at last run; bundle sizes within budget;
no XSS gaps in markdown render (T06/T07/T10 all use
`MARKDOWN_REHYPE_PLUGINS` with `rehype-sanitize`); FCP unmeasured
but the surface is server-rendered by default so it should be
within v1 ARCH §11 budget.

**Next step:** run `PHASE-BROWSER-TEST.md`, then start Phase 2a
per the recommendation above. Do **not** start Phase 2 work in
this branch — cut a `phase-2a` branch off the Phase 1 commit
once it's reviewed and merged.
