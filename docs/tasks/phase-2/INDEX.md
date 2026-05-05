# Phase 2 — Actions — Task Index

> **Phase 2 invariant:** the read-only invariant of Phase 1 is **lifted**.
> Mutations are now allowed, but **every mutation MUST**:
> 1. Travel through the daemon's MCP tool surface (no duplicated business
>    logic — `bridge_dispatch`, `bridge_kill`, `bridge_loop_approve`,
>    `bridge_loop_reject`).
> 2. Carry a valid CSRF double-submit token (P2-T8).
> 3. Pass the per-user rate-limit token bucket (P2-T7).
> 4. Be recorded in `audit_log` (P2-T4) — both the dashboard-side pre-MCP
>    write **and** the daemon-side post-MCP write, joined by `request_id`.
> 5. Have a confirmation step for destructive actions (P2-T11).
>
> **Status:** Iter 4/15 — T12 (MCP pool), T08 (CSRF), T07 (rate-limit)
> landed. T01..T06, T09..T11 + phase-test + sign-off remain.

---

## Source plans

- v2 plan (current): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v2/IMPLEMENTATION-PLAN.md` — Phase 2 section.
- v1 plan (text inherited where v2 says "kế thừa"): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/IMPLEMENTATION-PLAN.md` — Phase 2 (P2-T1..P2-T11).
- v2 architecture: `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v2/ARCHITECTURE.md` — §7 transport (MCP stdio for mutations), §13 MCP tool design, §15 versioning.
- v1 architecture (still load-bearing): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/ARCHITECTURE.md` — §3 data model (`audit_log` columns), §4 API surface (`tasks.dispatch`, `tasks.kill`, `loops.approve`/`reject`), §5 SSE (subscriber multiplex for permission relay), §10 security (CSRF Origin check, rate-limit, audit log, permission relay).
- Phase 2 review (this repo, in-tree): `docs/PHASE-2-REVIEW.md` — risk matrix, split 2a/2b proposal, architecture concerns, effort estimate.

The v2 path-rewrite rule is unchanged: every reference to `apps/web/` in v1
maps to this repo (`/Users/hieutran/projects/bridge-bot-ts-1/claude-bridge-dashboard/`).

---

## Phase 1 baseline (DONE) — what we inherit

All 13 Phase 1 tasks are committed on `main` (`63fe365` … `1ef045c`).
Phase 2 builds directly on this surface; do **not** rebuild.

- App Router shell with auth middleware (`middleware.ts`), JWT cookie session,
  5-route sidebar (`/agents`, `/tasks`, `/loops` placeholder, `/schedules`
  placeholder, `/cost`).
- tRPC v11 routers wired: `agents` (list/get/memory), `tasks` (list/listByAgent/
  get/transcript), `analytics` (dailyCost/summary). All **queries** — no
  mutations registered yet.
- Drizzle schema vendored at `src/db/schema.ts` covering daemon tables
  (`agents`, `tasks`, `permissions`, `teams`, `team_members`, `notifications`,
  `loops`, `loop_iterations`, `schedules`). **`audit_log` is NOT in the
  vendored schema** — see "Audit log migration note" below.
- SSE endpoint `/api/stream/tasks` (read-side) — server-side polling +
  diff-emit, signal-clean abort, no client consumer wired yet.
- Discovery: `src/lib/discovery.ts` reads `~/.claude-bridge/config.json` and
  exposes `{ dbPath, socket?, mcpEndpoint?, version, compatRange }`.
- `<OfflineBanner>` + error boundary already render `BridgeNotFoundError`
  state.
- Test surface: 257 Bun tests / 678 expects + 1 Playwright spec, all green.
  `tests/e2e/.fixture/` is the Playwright tmpdir SQLite fixture (excluded
  from `bun test` glob).
- Theme: `next-themes` wired with `disableTransitionOnChange`; dark default,
  no SSR flash.

**v2 Phase-2 path-rewrite already absorbed:** mutations route through the
daemon MCP server (rather than `child_process.spawn("bridge", …)`). The
mechanism for that — `mcpEndpoint` from `config.json` plus an MCP client —
is the focus of P2-T1 and P2-T12.

---

## Phase 2 task list — 12 tasks

Each task has its own file `T<NN>-<slug>.md` (TDD plan + acceptance + risk
mitigation extracted from `docs/PHASE-2-REVIEW.md`) and a matching
`T<NN>-review.md` (self-review) once implemented.

- [ ] **T01 — `tasks.dispatch` via MCP** *(scope: tRPC mutation procedure that connects to the daemon over MCP stdio (`mcpEndpoint` from `config.json`), invokes tool `bridge_dispatch({ agent, prompt, model? })`, maps daemon errors to typed tRPC errors, returns `{ taskId }`. **No** `child_process` shelling out to `bridge` CLI. Includes Zod input schema + timeout (15s) + structured error → toast mapping.)* — Review risk: **High** (transport rewrite, framing/escape risk on multi-line prompts, race when 2 dashboard processes spawn stdio).
- [ ] **T02 — Dispatch dialog UI (⌘K)** *(scope: client-side modal mounted globally, triggered by `⌘K` / button on `/agents`, with agent selector (`agents.list`) + textarea prompt + cost estimate placeholder. On submit calls `tasks.dispatch` mutation, shows toast linking to `/tasks/[id]`. shadcn `<Dialog>` + `<Command>` primitives.)* — Risk: **Low** (UI work; cost-estimate is rough).
- [ ] **T03 — Kill task action** *(scope: `tasks.kill({ id })` tRPC mutation calling MCP `bridge_kill` for the task's agent. Idempotent (already-done → return ok with warning, not error). Kill button on `/tasks/[id]` for `running` tasks; status flips to `killed` in ≤ 2 s.)* — Risk: **Medium** (idempotency surface; UI lag → killing already-done task should not error confusingly).
- [ ] **T04 — Audit log table & write helper** *(scope: SQLite migration for `audit_log(id, user_id, action, resource_type, resource_id, payload_json, ip_hash, user_agent, request_id, created_at)` matching v1 ARCH §3. `appendAudit({ ctx, action, resource, payload })` helper used by every mutation procedure. IP hash = SHA-256 + per-install salt (read once at boot).)* — Risk: **Low** (DB write). Cross-cutting dependency for T1/T3/T6/T9.
- [ ] **T05 — Audit log viewer page** *(scope: `/audit` route, owner-only, virtualized table (5 000+ rows), filters by user/action/resource/date. Reuses `<TaskFilters>` URL-param pattern from Phase 1. `system.auditLog` query already declared in v1 §4.6 — implement here.)* — Risk: **Low** (reuse pattern from `/tasks`).
- [ ] **T06 — Loop approve/reject inline** *(scope: in `/tasks/[id]` task detail, when the task is part of a loop in `pending_approval`, render Approve / Reject buttons. tRPC `loops.approve({ loopId })` / `loops.reject({ loopId, reason? })` mutations call MCP `bridge_loop_approve` / `bridge_loop_reject`. **Server-confirmed UI** — no optimistic update for this mutation per review §d.1.)* — Risk: **High** (race: same loop approved on web + rejected on Telegram simultaneously; daemon needs `BEGIN IMMEDIATE` or compare-and-swap).
- [x] **T07 — Rate-limit middleware** *(scope: tRPC `procedure` middleware enforcing token-bucket of 30 mutations/min/user. In-memory map keyed by `userId`; return tRPC `TOO_MANY_REQUESTS` (HTTP 429) with `Retry-After` header. Also rate-limit pre-auth `/login` to 5 req/min/IP per v1 §10. Audit-log a `rate_limit_blocked` row.)* — Risk: **Low** (single-process). Note: multi-replica deferred to Phase 4.
- [x] **T08 — CSRF double-submit cookie** *(scope: `csrf-csrf` lib (or hand-rolled HMAC token) issuing `csrfToken` cookie + `x-csrf-token` header on every mutation request. Missing/mismatch → HTTP 403. Applied at tRPC HTTP entry — `app/api/trpc/[trpc]/route.ts`. ADR: tRPC POST mutations only — Server Actions are not used. Documented in `docs/adr/0001-csrf-strategy.md`.)* — Risk: **Medium** (Next.js Server Actions vs tRPC POST mismatch — this task locks tRPC POST as the only mutation surface).
- [ ] **T09 — Permission relay UI** *(scope: extend `/api/stream/tasks` (or new `/api/stream/permissions`) to multiplex `tool_use_pending` events from the daemon's `permissions` table. Toast with Allow/Deny calls a tRPC mutation that updates the row (or invokes a daemon MCP tool if exposed). Replaces Telegram for the permission flow when the user is at the dashboard.)* — Risk: **High** (cross-repo schema drift on `tool_use_pending` event format; `permissions` table is daemon-owned).
- [ ] **T10 — Optimistic UI updates** *(scope: React Query `useMutation` `onMutate`/`onError` rollback for dispatch + kill. `loops.approve`/`reject` are **server-confirmed** (no optimistic) per review §d.1. Tests assert rollback path on simulated 500.)* — Risk: **Low** (RQ convention).
- [ ] **T11 — Confirmation pattern** *(scope: shadcn `<AlertDialog>` for destructive actions (kill, cancel loop). Typing the agent name (or task ID prefix) to enable the action button. Reusable `<DangerConfirm name=… verb=…>` primitive used by T03 + T06.)* — Risk: **Low** (UX guard).
- [x] **T12 — MCP client connection pool** *(scope: `src/server/mcp/pool.ts` — long-lived stdio MCP client(s); reuse a single `bridge mcp-stdio` child process per dashboard process; reconnect-on-EOF with exponential backoff; backpressure (pending-request queue with cap = 32) to avoid spawning N child processes for N concurrent mutations. Acceptance: 100 dispatches in parallel → still 1 child process; p95 round-trip < 500 ms; chaos test "kill daemon mid-call" → reset connection cleanly, fail-fast pending requests, no hang.)* — Risk: **Medium** (framing buffer corruption on partial read; signal-handling on Bun.spawn). **Foundation for T1, T3, T6, T9 — must land first.**

---

## Dependency graph

```
                      ┌──────────────────────────────┐
                      │  P1 baseline (DONE)          │
                      │  - discovery.ts (mcpEndpoint)│
                      │  - auth/JWT cookie session   │
                      │  - SSE /api/stream/tasks     │
                      │  - /tasks/[id] detail        │
                      │  - vendored Drizzle schema   │
                      └──────────────┬───────────────┘
                                     │
                          ┌──────────▼─────────┐
                          │ T12 MCP pool       │  ← FOUNDATION
                          │ (stdio reuse,      │
                          │  reconnect, queue) │
                          └──┬───────────┬─────┘
                             │           │
              ┌──────────────┴──┐   ┌────▼──────────────┐
              │ T08 CSRF        │   │ T07 rate-limit    │
              │ (mutation entry)│   │ (mutation entry)  │
              └────────┬────────┘   └────────┬──────────┘
                       │                     │
                       └──────────┬──────────┘
                                  │
                          ┌───────▼────────┐
                          │ T04 audit_log  │  ← cross-cutting helper
                          │  schema + write│    (called by T1/T3/T6/T9)
                          └───────┬────────┘
                                  │
        ┌───────────────┬─────────┼─────────┬──────────────┐
        │               │         │         │              │
   ┌────▼────┐    ┌────▼────┐ ┌──▼──┐   ┌──▼──┐       ┌───▼────┐
   │ T01     │    │ T03     │ │ T06 │   │ T09 │       │  …     │
   │dispatch │    │  kill   │ │loop │   │perm │       │        │
   │  (MCP)  │    │  (MCP)  │ │ a/r │   │relay│       │        │
   └────┬────┘    └────┬────┘ └──┬──┘   └─────┘       │        │
        │              │         │                    │        │
        ▼              ▼         ▼                    │        │
   ┌────────┐     ┌────────┐ (server-                 │        │
   │ T02    │     │ T11    │  confirm,                │        │
   │ dialog │     │ confirm│  no opt)                 │        │
   └────────┘     └────────┘                          │        │
        │              │                              │        │
        └──────┬───────┘                              │        │
               ▼                                      │        │
        ┌───────────┐                                 │        │
        │ T10       │                                 │        │
        │ optimistic│                                 │        │
        └───────────┘                                 │        │
                                                      │        │
   T01..T06 mutations ──────► T05 audit viewer ◄──────┘        │
                                                               │
   T09 permission relay (highest cross-repo risk) ◄─────────────┘
```

### Critical path (foundation-first hybrid)

```
T12 → T08 → T07 → T04 → T01 → T03 → T06 → T02 → T05 → T11 → T10 → T9
```

12 atomic loop steps map 1:1 with the iter plan in the loop prompt
(steps 2..13). Step 14 = phase test sweep, step 15 = sign-off.

### Iteration mapping (loop steps 2..15)

| Loop step | Task                  | Why this slot                                 |
|-----------|-----------------------|-----------------------------------------------|
| 2         | T12 MCP pool          | Foundation for all transport tasks            |
| 3         | T08 CSRF              | Mutation entry guard — must precede mutations |
| 4         | T07 rate-limit        | Mutation entry guard — pairs with T08         |
| 5         | T04 audit_log         | Cross-cutting; mutations need it on day one   |
| 6         | T01 dispatch (MCP)    | First real mutation; exercises T12+T08+T07+T04|
| 7         | T03 kill              | Second mutation; same call shape as T01       |
| 8         | T06 loop approve/rej  | Third mutation; high-risk race scenario       |
| 9         | T02 dispatch dialog   | UI for T01 — needs `tasks.dispatch` to exist  |
| 10        | T05 audit viewer      | Read-side; needs T04 to have written rows     |
| 11        | T11 confirmation      | UX guard; reused retroactively in T03 + T06   |
| 12        | T10 optimistic UI     | RQ wiring; needs T01 + T03 mutations stable   |
| 13        | T09 permission relay  | Highest risk last; failure here doesn't block other tasks|
| 14        | Phase test sweep      | `bun test`, `bun run build`, Playwright       |
| 15        | Sign-off              | PHASE-BROWSER-TEST.md + PHASE-2-COMPLETE.md   |

---

## Sequencing decision — foundation-first hybrid (NOT 2a/2b split)

**Decision: keep Phase 2 as a single phase, sequenced foundation-first
hybrid `T12 → T08 → T07 → T04 → T01 → T03 → T06 → T02 → T05 → T11 → T10 → T09`.**

`docs/PHASE-2-REVIEW.md` §g recommends a 2a/2b split. We **decline** the
split for the loop, with these reasons:

1. **Foundation-first achieves the same risk isolation.** The split's
   stated goal is to isolate transport-layer risk (T1, T9, T12) from
   "easy" mutations. By landing T12 (MCP pool) first as a standalone
   commit before any mutation procedure, every subsequent mutation
   piggy-backs on a tested transport — the same isolation the split
   produces, without two phase-exit ceremonies.
2. **Audit + middleware are *cross-cutting*, not "read-side"** — the
   review's 2a tier puts T4/T5/T11 in 2a, but T4 must be wired before
   *any* mutation lands or every mutation procedure has to be edited
   twice. Doing T04 at slot 5 (before T01) is the correct ordering;
   re-categorising it as "2a" obscures that.
3. **Vertical slice is preserved per task, not per sub-phase.** Each
   `T<NN>` already produces a working slice (commit-shippable). The
   Phase 1 loop demonstrated this works for 13 tasks with one phase-exit
   ceremony; doubling the ceremony does not buy more correctness.
4. **T09 (permission relay) is genuinely the riskiest** — placing it
   *last* (slot 13) means if it slips, slots 2..12 still ship as a
   coherent phase: dispatch, kill, audit, approve, dialog, optimistic
   UI all work without permission relay. The split puts T09 in 2b
   without that explicit "skip-to-end" property.
5. **Cost budget is identical** ($25–60 realistic per review §f); the
   split adds two sign-off doc rounds (~$2) for no risk reduction.

**Caveat that would flip the decision:** if iter 2 (T12) reveals that
the daemon's `bridge mcp-stdio` subcommand does not yet exist or the
stdio framing is unstable, we abort the loop, ship a 2a-only PR
covering T03/T06/T04/T05/T11 (which use existing CLI fallback paths),
and treat 2b as a follow-up after daemon work. The loop will surface
this in iter 2's review doc.

**Open architectural concerns from review §d that this loop will
resolve in-line (not deferred):**

- §d.1 *Optimistic UI scope* → encoded in T10 spec: optimistic for
  dispatch + kill only; loops.approve/reject is server-confirmed.
- §d.2 *Audit log write path* → encoded in T04 spec: dashboard writes
  pre-MCP audit row; daemon-side audit (when daemon adds it) joins
  on `request_id`. T04 ships only the dashboard side; daemon-side is
  out of scope for this repo's loop.
- §d.3 *Pre-auth rate limit* → encoded in T07 spec: 5/min/IP for
  `/login`, 30/min/user for mutations.
- §d.4 *CSRF Server Action vs tRPC POST* → encoded in T08 spec: ADR
  `docs/adr/0001-csrf-strategy.md` locks tRPC POST as the only
  mutation surface; Server Actions are not used.
- §d.5 *MCP cancel signal mid-call* → encoded in T12 spec: pool
  exposes a per-request `AbortController`; cancel propagates as
  EPIPE/connection reset → fail-fast pending requests.

---

## Audit log migration note

The vendored Drizzle schema (`src/db/schema.ts`) was introspected from
the daemon's `bridge.db` and **does not include an `audit_log` table**.
The dashboard owns the web layer (per v1 ARCH §3 — "Dashboard không tạo
bảng mới cho domain entity, chỉ thêm `users`, `web_sessions`, `audit_log`").

**Approach for T04:**

1. Author migration `src/db/migrations/0001_audit_log.sql` (idempotent
   `CREATE TABLE IF NOT EXISTS audit_log (...)` matching v1 ARCH §3
   columns: `id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
   action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
   payload_json TEXT, ip_hash TEXT, user_agent TEXT, request_id TEXT,
   created_at INTEGER NOT NULL`).
2. Add to vendored Drizzle schema (`src/db/schema.ts`) — a *dashboard-
   owned* table, distinct from daemon-vendored tables. Annotate with a
   comment block stating ownership.
3. Run-once migration runner at server boot (`src/server/migrate.ts`) —
   reuses `discovery.ts` for the DB path, applies pending SQL in
   filename order. Safe under concurrent dashboard processes (uses
   `BEGIN IMMEDIATE` + `IF NOT EXISTS`).
4. Daemon coordination: file an issue against `claude-bridge` to
   register `audit_log` in the canonical schema vendor (`schemas/db.v1.ts`)
   so it survives a future `bun run sync-schema` run (deferred from
   Phase 1 P1-T14). Out of scope for this loop — flagged in
   `PHASE-2-COMPLETE.md`.

`web_sessions` and `users` tables already exist (Phase 1 T02 path).
Only `audit_log` is new in Phase 2.

---

## Architecture references per task (read before coding)

| Task | Sections to read |
|------|------------------|
| T01  | v2 ARCH §7.3 (MCP stdio for mutations); v1 ARCH §4.2 `tasks.dispatch`, §10 (audit + CSRF) |
| T02  | v1 ARCH §11 (perf — TTI < 1.0 s for modal mount); shadcn `<Dialog>` + `<Command>` |
| T03  | v1 ARCH §4.2 `tasks.kill`; idempotency from review risk-tier table |
| T04  | v1 ARCH §3 (`audit_log` columns), §10 (IP hash policy) |
| T05  | v1 ARCH §4.6 `system.auditLog`, §11 (virtualized table); reuse `<TaskFilters>` URL pattern |
| T06  | v1 ARCH §4.3 `loops.approve`/`reject`; v2 ARCH §13 (MCP tool surface) — review §c risk **High** |
| T07  | v1 ARCH §10 (rate-limit policy: 5/min/IP login, 30/min/user mutation) |
| T08  | v1 ARCH §10 (Origin check); ADR locks tRPC POST as mutation surface |
| T09  | v1 ARCH §10 ("permission relay abuse"); v1 ARCH §5 SSE multiplex — review §c risk **High** |
| T10  | v1 ARCH §11 (perf — optimistic mutation roundtrip target); review §d.1 |
| T11  | v1 ARCH §10 (audit on kill); shadcn `<AlertDialog>` |
| T12  | v2 ARCH §7.3 (MCP stdio reuse vs spawn-per-call); review §c risk **Medium** + §d.5 |

---

## Notes / open questions

- **CLAUDE.md (in-repo) does not yet mention Phase 2 mutation rules.**
  Update at sign-off (step 15) to document the "every mutation must
  pass T07 + T08 + T04" invariant for future contributors.
- **Daemon `bridge mcp-stdio` subcommand existence** — the loop assumes
  it exists. T12 iter 2 will probe; if missing, see "Caveat that would
  flip the decision" above.
- **Multi-replica rate-limit** — in-memory token bucket only works
  single-process. Phase 4 (Docker compose) must migrate to SQLite or
  Redis. Flagged in `PHASE-2-COMPLETE.md`.
- **`csrf-csrf` lib vs hand-rolled** — T08 will pick concretely;
  hand-rolled HMAC token is preferred to keep dependency surface
  small (Phase 4 will revisit if multi-user requires more).
- **No commit/push** during the loop — user reviews the diff before
  shipping.
- **Pre-existing untracked files** (`MIGRATION-COMPLETE.md`,
  `docs/PHASE-2-REVIEW.md`, `tests/e2e/.fixture/`) are not Phase 2
  artifacts and will not be auto-committed by the loop.

---

*Index written by loop iter 1/15 on 2026-05-06. Update checkboxes as
tasks land. If a task spec changes mid-loop, edit its
`T<NN>-<slug>.md` and note the delta here.*
