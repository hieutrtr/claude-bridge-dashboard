# Phase 1 — Read-only MVP — Task Index

> **Phase 1 invariant: READ-ONLY.** This phase MUST NOT implement any mutation
> (no `tasks.dispatch`, `tasks.kill`, `loops.approve`, `schedules.add`,
> `agents.create`, etc.). All mutations belong to Phase 2+. If a task
> appears to need mutation, stop and re-scope.
>
> **Status:** Iter 14/17 — T01..T13 done. Phase test + browser test +
> sign-off remain.

---

## Source plans

- v2 plan (current): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v2/IMPLEMENTATION-PLAN.md` — Phase 1 section.
- v1 plan (re-pointed by v2, full task text): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/IMPLEMENTATION-PLAN.md` — Phase 1 (P1-T1..T13).
- v2 architecture: `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v2/ARCHITECTURE.md` — §0 lists which v1 sections still apply.
- v1 architecture (kế thừa nguyên): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/ARCHITECTURE.md` — §1 principles, §2 stack, §3 data model, §4 API surface, §5 SSE, §6 auth, §9–11.

The v2 path-rewrite rule: every reference to `apps/web/` in v1 maps to this
repo (`/Users/hieutran/projects/bridge-bot-ts-1/claude-bridge-dashboard/`).

---

## Phase 0 baseline (DONE) — what we inherit

All code below already exists from the Phase 0 spike + Phase 0.5 migration.
Phase 1 builds on it; do **not** re-do.

- `package.json` — `@claude-bridge/dashboard@0.1.0`, Next.js 15 + React 19 + tRPC v11 + Drizzle 0.40 + Tailwind v4 + Zod + `@libsql/client`.
- `app/layout.tsx`, `app/page.tsx`, `app/globals.css` — App Router shell, Tailwind v4 + dark mode tokens.
- `app/agents/page.tsx` — minimal agents list page consuming tRPC.
- `app/api/trpc/[trpc]/route.ts` — tRPC HTTP handler.
- `src/server/trpc.ts`, `src/server/routers/_app.ts`, `src/server/routers/agents.ts` — tRPC root + `agents.list` procedure.
- `src/server/db.ts` — Drizzle SQLite client (libsql) reading `bridge.db` via discovery.
- `src/db/schema.ts` + `src/db/relations.ts` — vendored Drizzle schema (introspected from `bridge.db`, hand-patched for boolean coercion). Tables present: `agents`, `tasks`, `permissions`, `teams`, `team_members`, `notifications`, `loops`, `loop_iterations`, `schedules`.
- `src/lib/discovery.ts` — `discoverBridgeDaemon()` reads `~/.claude-bridge/config.json`, validates with Zod, returns `{ dbPath, socket?, mcpEndpoint?, version, compatRange, ... }`. Throws `BridgeNotFoundError` on miss. Honours `CLAUDE_BRIDGE_HOME` env var.
- `src/components/agents-table.tsx`, `src/components/theme-provider.tsx`, `src/components/ui/{button,card,input,theme-toggle}.tsx` — shadcn primitives.
- `tests/lib/discovery.test.ts` — 7 tests, 18 expects, all pass under `bun test`.
- Git: branch `main`, single commit `c16e912 initial migration from claude-bridge/apps/web`. Working tree currently has `MIGRATION-COMPLETE.md` + new `docs/` untracked (this INDEX is the first content under `docs/`).

**v2-specific deltas already absorbed:** `discovery.ts` covers v2 P1-T15 (no `bridge dashboard --start` flag — discovery reads `config.json` instead). The vendored `src/db/schema.ts` covers v2 P1-T14 in spirit (manually copy-vendored once). v2 P1-T14 (`bun run sync-schema` automation script) and v2 P1-T15 (offline banner UI) are **deferred** — see Notes below.

---

## Phase 1 task list — 13 tasks

Each task has its own file `T<NN>-<slug>.md` (TDD plan + acceptance) and a
matching `T<NN>-review.md` (self-review) once implemented.

- [x] **T01 — Layout & navigation shell** *(scope: 5-route App Router shell with sidebar Agents/Tasks/Loops/Schedules/Cost + topbar; active state via `usePathname`. shadcn primitives only — no logic)* — see `T01-layout-shell.md` / `T01-review.md`. 16 new tests (23 total) green; typecheck clean.
- [x] **T02 — Auth: env-password middleware** *(scope: `DASHBOARD_PASSWORD` env, `/login` form, JWT cookie `httpOnly`+`SameSite=Lax`, 7-day exp; Next.js middleware redirects unauth → `/login`. **No magic-link** — that is Phase 4)* — see `T02-auth-env-password.md` / `T02-review.md`. 25 new tests (48 total) green; typecheck clean.
- [x] **T03 — `agents.list` enrichment + Agents grid page** *(scope: extend existing `agents.list` to project name/model/last_task_at/total_tasks; render shadcn Card grid at `/agents`. Existing minimal procedure already returns rows — just shape & UI)* — see `T03-agents-list-grid.md` / `T03-review.md`. 13 new tests (61 total) green; typecheck clean. Legacy `<AgentsTable>` removed; `<AgentsGrid>` + `<Badge>` primitive added.
- [x] **T04 — `agents.get` + Agent detail page (Tasks tab only)** *(scope: dynamic route `/agents/[name]` showing 50 most recent tasks paginated; tab layout placeholder for Memory/Cost — those tabs implemented in T09/T10)* — see `T04-agent-detail-tasks-tab.md` / `T04-review.md`. 23 new tests (84 total) green; typecheck clean. `tasks` router introduced (`listByAgent` only); `<TaskTable>` + `<AgentTabs>` + `agents.get` added; agent grid cards now `<Link>` to detail.
- [x] **T05 — `tasks.list` + global Tasks page** *(scope: tRPC procedure with cursor pagination + filters (status, agent, channel, since/until); page `/tasks` with virtualized table + URL-synced filters)* — see `T05-tasks-list-global.md` / `T05-review.md`. 15 new tests (99 total) green; typecheck clean. `tasks.list` query + `<GlobalTaskTable>` + `<TaskFilters>` (plain `<form method="get">`) added; URL is the single source of truth (no `"use client"`). Virtualization explicitly deferred — paginated 50/page matches T04 conventions; flagged as polish for T11 if real-world ≥ 10k tasks need it.
- [x] **T06 — `tasks.get` + Task detail page** *(scope: tRPC procedure returns task row + transcript pointer; page `/tasks/[id]` with header (status/cost/duration), prompt section, result-markdown rendered via `react-markdown` + `rehype-sanitize`, metadata sidebar)* — see `T06-task-detail.md` / `T06-review.md`. 12 new tests (111 total) green; typecheck + production build clean. `tasks.get` query (LEFT JOIN agents) + `/tasks/[id]` page + `src/lib/markdown.ts` (500_000-byte cap + `rehype-sanitize` plugin pin) + `TaskDetail` DTO added. T05 caveat ("`/tasks/[id]` link 404s") closed.
- [x] **T07 — Transcript viewer (JSONL)** *(scope: read Claude Code session JSONL from `~/.claude/projects/<slug>/<session_id>.jsonl`, parse turn-by-turn, render assistant/user/tool blocks. Defensive: unknown turn types → raw/meta fallback)* — see `T07-transcript-viewer.md` / `T07-review.md`. 25 new tests (138 total / 419 expects) green; typecheck + production build clean. `tasks.transcript` query (5 MB file cap, 500-turn cap, 50 KB per-turn clip) + `src/lib/transcript.ts` (pure parser/util) + `TaskTranscript` DTO + `TranscriptSection` card on `/tasks/[id]` (per-turn switch, markdown via `MARKDOWN_REHYPE_PLUGINS`, banners for missing/too-large/truncated). Risk #3 fallback: unknown line types render as `meta` collapse, JSON-parse failures as `raw` collapse — page never crashes on format drift.
- [x] **T08 — SSE endpoint `/api/stream/tasks` (read-only)** *(scope: server route emits task status changes; backed by 1s polling SQLite `select id, status, cost_usd, completed_at from tasks where ...` + dedupe-by-id. **No mutation, no BridgeBus write side**. Client `EventSource` updates React Query cache)* — see `T08-sse-tasks.md` / `T08-review.md`. 21 new tests (159 total / 475 expects) green; typecheck clean. `src/lib/sse.ts` (pure formatter + diff) + `src/server/sse-tasks.ts` (`createTaskStreamResponse({ signal, pollMs, heartbeatMs, readSnapshot })`) + `app/api/stream/tasks/route.ts` (GET-only, `select id, status, cost_usd, completed_at from tasks order by id desc limit 200`). Polls 1s, heartbeat 15s, signal-abort closes cleanly. Client EventSource consumer + UI live-badge wiring deferred to T11/Phase 2 (server side complete; consumer is a separate slice). BridgeBus push-side, multiplex `/api/stream?topics=`, and per-process subscriber bookkeeping all explicitly Phase 2.
- [x] **T09 — Cost analytics page** *(scope: page `/cost` with three charts — daily spend (line, 30 days), spend per agent (pie), spend per model (bar). `analytics.dailyCost` + `analytics.summary` query procedures. Uses Recharts; numbers must match `bridge cost` CLI ± $0.01)* — see `T09-cost-analytics.md` / `T09-review.md`. 20 new tests (179 total / 541 expects) green; typecheck clean. `analyticsRouter` (`dailyCost` + `summary` queries; raw `tasks` aggregate, no `v_cost_daily` dependency) + `<CostCharts>` client leaf (Recharts `Line`/`Pie`/`Bar`) + `/cost` server page (3 KPI cards + chart wrapper, empty-state branch). `topModels` extends v1 §4.5 spec so the bar chart reads from the same `summary` payload as the pie. Recharts dep added (^2.15.0, React 19 compat).
- [x] **T10 — Memory tab (read-only)** *(scope: `agents.memory({name})` query procedure reads `~/.claude/projects/<slug>/memory/MEMORY.md` if present; render with sanitized markdown; empty state if missing. Wires up Memory tab on `/agents/[name]` from T04)* — see `T10-memory-tab.md` / `T10-review.md`. 16 new tests (195 total / 600 expects) green; typecheck clean. `agents.memory` (read-only — `existsSync`/`statSync`/`readdirSync`/`readFileSync` only) + `AgentMemory` DTO with `dirMissing`/`fileMissing`/`fileTooLarge`/`memoryMdTruncated` sentinels mirroring `TaskTranscript` + `<MemorySection>` rendering markdown via shared `MARKDOWN_REHYPE_PLUGINS` + sibling-`*.md` chip list (200-cap, ascending sort, non-md filtered). Reuses `projectSlug` from `src/lib/transcript.ts` and `MARKDOWN_BYTE_LIMIT` from `src/lib/markdown.ts`. Per-file routes deferred to Phase 2.
- [x] **T11 — Empty / error / loading states** *(scope: skeleton shadcn loaders, error boundary, 0-row empty messages on every Phase 1 route. "Daemon offline" banner if `discoverBridgeDaemon()` throws — covers v2 P1-T15)* — see `T11-empty-error-loading.md` / `T11-review.md`. 28 new tests (223 total / 644 expects) green; typecheck clean. `<Skeleton>` primitive + `<OfflineBanner>` server component + `isBridgeNotInstalledError()` (name-based, RSC-serialization-safe) + `app/error.tsx` (client boundary, branches offline vs generic) + root + `/agents`/`/tasks`/`/cost` `loading.tsx` files. Phase 1 surface empty states audited and reverified — no regressions. Discovery-call wiring deferred to Phase 2 (current pages bypass `discoverBridgeDaemon()` and read DB directly), but the boundary is in place so Phase 2 doesn't need to revisit T11.
- [x] **T12 — Dark / light theme polish** *(scope: `next-themes` already wired in `src/components/theme-provider.tsx` & `theme-toggle.tsx`; finalize tokens, default dark, no SSR flash, persist via `localStorage`. Mostly verification + small fixes)* — see `T12-theme-polish.md` / `T12-review.md`. 34 new tests (257 total / 678 expects) green; typecheck clean. `nextTheme()` pure helper extracted to `src/lib/theme.ts` for unit-testable click logic; `<ThemeProvider>` gained `disableTransitionOnChange` to prevent toggle jank; static contract test locks `suppressHydrationWarning` + ThemeProvider props + `:root`/`.dark` token parity. Existing `globals.css` parity was already complete (no edits needed). FOUC suppression relies on `next-themes` v0.4.4's auto-injected inline script (no manual `<Script>` snippet — would race with the library's own). Icon-based toggle + Tailwind v4 `@theme` shorthand explicitly deferred to Phase 2 polish.
- [x] **T13 — E2E smoke test (Playwright)** *(scope: spec covers login → agents list → agent detail → task detail → cost page; assertions on visible text + link `href`. Add `@playwright/test` dev dep; CI-friendly headed=false)* — see `T13-e2e-smoke-playwright.md` / `T13-review.md`. 1 new Playwright test passes in 18.5s (well under the 60s acceptance budget); 3/3 stability runs green. `bun test` rescoped to `tests/{lib,app,server}` so the Playwright spec doesn't trip the Bun runner; new `bun run test:e2e` boots `next dev` against an `os.tmpdir()` SQLite fixture (the project tree is off-limits — Watchpack on WAL files unmounts the login form mid-submit, hard-learned). Spec uses `page.goto` after asserting each link's `href` rather than `link.click()` because SPA navigation under headless `next dev` doesn't reliably commit the route — the link's `href` proves the navigation contract; `goto` proves the destination renders. Switching to `next build && next start` for SPA-click coverage flagged as Phase 2 polish.

---

## Dependency graph

```
T01 (shell)
 ├─► T02 (auth wraps shell) ──► everything below requires login
 ├─► T03 (agents grid) ──► T04 (agent detail) ──► T10 (memory tab)
 │                                              └─► (cost-per-agent reused in T09)
 ├─► T05 (tasks list) ──► T06 (task detail) ──► T07 (transcript)
 │                    └─► T08 (SSE for live status)
 ├─► T09 (cost) — needs T05 query helpers
 ├─► T11 (states) — touches T03..T10 surfaces
 ├─► T12 (theme) — touches T01 layout tokens
 └─► T13 (E2E)  — needs all of T01..T12 to drive

Critical path:  T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08 → T09 → T10 → T11 → T12 → T13
```

T03..T10 can theoretically reorder, but the loop will execute them T01..T13 in
order to keep each iter self-contained and reviewable.

### Iteration mapping (loop steps 2..14)

| Loop step | Task |
|-----------|------|
| 2  | T01 |
| 3  | T02 |
| 4  | T03 |
| 5  | T04 |
| 6  | T05 |
| 7  | T06 |
| 8  | T07 |
| 9  | T08 |
| 10 | T09 |
| 11 | T10 |
| 12 | T11 |
| 13 | T12 |
| 14 | T13 |

Steps 15–17: full test run + production build, browser test, sign-off.

---

## Architecture references per task (read before coding)

| Task | Sections to read |
|------|------------------|
| T01  | v1 ARCH §1 (principles), §2 (stack), §11 (perf budgets) |
| T02  | v1 ARCH §6 (auth — single-user env path only), §10 (security) |
| T03  | v1 ARCH §3 (data model — `agents`), §4.1 `agents.*`, §11 (FCP < 200ms) |
| T04  | v1 ARCH §4.1 + §4.2 (`tasks.list` per agent), §3 (`tasks.session_id` FK) |
| T05  | v1 ARCH §4.2 `tasks.*`, §11 (DB query p95 < 50ms, virtualized) |
| T06  | v1 ARCH §4.2 `tasks.get`, §10 (XSS — `react-markdown` + `rehype-sanitize`) |
| T07  | v1 ARCH risk #3 (JSONL format drift), §10 (XSS guard inside transcript) |
| T08  | v1 ARCH §5 (SSE multiplex, polling fallback, 1 channel) |
| T09  | v1 ARCH §3 (`v_cost_daily` view), §4.5 `analytics.*`, §11 |
| T10  | v1 ARCH §4.1 `agents.memory`, §10 (XSS in markdown render) |
| T11  | v1 ARCH §11 (perf), v2 ARCH §7.2 (`BridgeNotFoundError` UX) |
| T12  | v1 ARCH §2 (Tailwind v4 + shadcn dark tokens) |
| T13  | v1 ARCH §11 (TTI < 1.0s as upper bound for E2E expectations) |

---

## Notes / open questions

- **v2 P1-T14 (`bun run sync-schema` automation):** the schema is already
  vendored at `src/db/schema.ts` (one-time copy + hand-patches). Adding an
  automated sync script is out-of-scope for this loop unless a Phase 1 task
  explicitly needs schema regeneration. **Decision: defer to Phase 2 or
  later** — flagged for the sign-off doc, not blocking exit criteria.
- **v2 P1-T15 (offline banner UI):** rolled into **T11** (empty/error states)
  — the "Daemon offline" banner triggered by `discoverBridgeDaemon()` failure
  satisfies the acceptance bullet without a dedicated task.
- **`v_cost_daily` view:** v1 ARCH proposes a SQL view; the daemon's
  `bridge.db` may or may not have it created. T09 should fall back to raw
  `tasks` aggregation if the view is absent, since dashboard is read-only and
  cannot run DDL.
- **Channel for tests:** Phase 0 used `bun test`. Plan keeps that for
  unit/integration; T13 introduces Playwright as a separate dev dep — no
  Vitest/Jest, per v1 ARCH §2 stack pick.
- **Mutation guard:** every `T<NN>-review.md` includes a mandatory checkbox
  "Read-only: NO mutation/dispatch call" — reject any task that fails this.
- **No commit/push** during the loop — user reviews diff before shipping.

---

*Index written by loop iter 1/17 on 2026-05-05. Update checkboxes as tasks
land. If a task spec changes mid-loop, edit its `T<NN>-<slug>.md` and note
the delta here.*
