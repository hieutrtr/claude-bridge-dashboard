# P1-T03 — `agents.list` enrichment + Agents grid page

> Phase 1, Task 3 of 13. Read-only invariant — query-only procedure, no
> mutation. Builds on T02-gated shell.

## Source

- v1 plan task: `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/IMPLEMENTATION-PLAN.md`
  line 69 — *"P1-T3 — `agents.list` + Agents grid page · Card grid hiển thị
  name, project, model, last_task_at, total_tasks, status badge.
  Acceptance: 20 agent test render < 200ms FCP."*
- v2 plan: re-points to v1 P1-T3 (path-rewrite only; acceptance preserved).

## Architecture refs to read first

- `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/ARCHITECTURE.md`
  - **§3 Data model — `agents` table.** Columns we project: `name`,
    `project_dir`, `model`, `state`, `last_task_at`, `total_tasks`. We
    intentionally **do not** ship `session_id`, `agent_file`, `purpose`,
    or `created_at` to the client — UI doesn't need them and they bloat
    the JSON payload (perf budget §11).
  - **§4.1 `agents.*` API surface.** Phase 0 already exposes
    `agents.list(): Agent[]`. We keep the same procedure name and shape,
    but tighten the DTO from `InferSelectModel<typeof agents>` (raw
    Drizzle row) to a hand-written `Agent` interface that matches the
    grid's needs. `agents.get` is **out of scope** for T03 — that's T04.
  - **§11 Performance budgets.** First-load JS < 200 KB, FCP < 200ms with
    20 rows. Card grid layout: CSS grid `repeat(auto-fill,minmax(...,1fr))`
    — no JS sorting, no client-side filter (filters live on `/tasks`
    in T05). The `<Card>` primitive from `src/components/ui/card.tsx` is
    already vendored from T01.
- v2 ARCH §0 confirms §3, §4.1, §11 are inherited unchanged.

## Spec (paraphrased from plan)

> Card grid hiển thị name, project, model, last_task_at, total_tasks,
> status badge. Acceptance: 20 agent test render < 200ms FCP.

## Acceptance criteria

1. `agents.list` returns `Agent[]` where `Agent` is an explicit DTO with
   exactly: `name: string`, `projectDir: string`, `model: string | null`,
   `state: string | null`, `lastTaskAt: string | null`,
   `totalTasks: number | null`. No `sessionId`, `agentFile`, `purpose`, or
   `createdAt` — those are server-only.
2. The procedure stays a `query` (read-only). No new mutation lands.
3. A pure helper `agentStatusBadge(state: string | null): { label: string;
   variant: "running" | "idle" | "error" | "unknown" }` derives a badge
   shape from the raw `state` column. Mapping (per daemon convention):
   - `"running"` → `{ label: "Running", variant: "running" }`
   - `"idle" | "created"` → `{ label: state === "created" ? "Created" :
     "Idle", variant: "idle" }`
   - `"errored" | "killed"` → `{ label: <Title-case>, variant: "error" }`
   - `null | "" | unknown` → `{ label: "Unknown", variant: "unknown" }`
4. `/agents` page renders an `AgentsGrid` component using shadcn `<Card>` /
   `<CardHeader>` / `<CardTitle>` / `<CardContent>`. Each card shows:
   - Title: agent name.
   - `state` badge (color via `variant`).
   - Project dir (mono font, truncated with `title=` for full path).
   - Model (lowercase, e.g. `sonnet`).
   - "Last task: <relative-or-absolute timestamp>" (raw string ok if
     parsing fails — defensive).
   - "Total tasks: N" (or `0` if null).
5. Empty state: when `agents.list` returns `[]`, the page renders a
   single placeholder card / message instead of an empty grid (UX hint
   for fresh installs).
6. The legacy `<AgentsTable>` from Phase 0 is removed or replaced by
   `<AgentsGrid>` to avoid two parallel components for the same data.
7. **Read-only invariant:** no new mutation procedure, no
   `bridge_dispatch`, no DB write. ✅

## Test plan (TDD — Bun test)

The procedure is testable end-to-end via the tRPC `createCaller` against a
fresh temp SQLite DB. The badge helper is a pure function. Following the
T01/T02 convention, **no React rendering tests** — component shape is
verified by route-stub (existing T01 test) + manual/Playwright (T13).

### `tests/server/agents-router.test.ts` (NEW)

Open a temp SQLite, run the minimal DDL needed to create the `agents`
table (we don't depend on full daemon schema), seed N rows, point
`BRIDGE_DB` at the temp file, `resetDb()`, then call
`appRouter.createCaller({}).agents.list()`.

- empty DB → `[]`.
- seeded with 3 agents → returns 3 rows in some stable order (DB row
  order ok); each row has only the 6 DTO fields, no `sessionId` /
  `agentFile` / `purpose` / `createdAt`.
- field types — `name` and `projectDir` are non-empty strings; `model`,
  `state`, `lastTaskAt` may be `null`; `totalTasks` is a number when
  present (Drizzle returns `0` default), `null` otherwise.
- 20-row smoke — insert 20 rows, assert `list().length === 20` and each
  has the DTO shape (covers the "20 agent" acceptance bullet at the data
  layer; FCP/render perf is verified by Playwright in T13).

### `tests/lib/agent-status.test.ts` (NEW)

`agentStatusBadge`:
- `"running"` → `{ label: "Running", variant: "running" }`.
- `"idle"` → `{ label: "Idle", variant: "idle" }`.
- `"created"` → `{ label: "Created", variant: "idle" }`.
- `"errored"` → `{ label: "Errored", variant: "error" }`.
- `"killed"` → `{ label: "Killed", variant: "error" }`.
- `null` → `{ label: "Unknown", variant: "unknown" }`.
- `""` → `{ label: "Unknown", variant: "unknown" }`.
- arbitrary `"some-future-state"` → `{ label: "Unknown",
  variant: "unknown" }` (defensive — daemon may add states).

### Pre-existing tests stay green

- `tests/app/route-stubs.test.ts` already asserts `app/agents/page.tsx`
  exists and exports a function — both remain true after the rewrite.
- `tests/lib/discovery.test.ts`, `tests/lib/nav.test.ts`,
  `tests/lib/auth.test.ts`, `tests/app/auth-*.test.ts` — untouched.

## Files to create / modify

- NEW `src/server/dto.ts` — exports the `Agent` DTO type used by
  `agents.list` (and reused later by T04 `agents.get`).
- NEW `src/lib/agent-status.ts` — `agentStatusBadge` pure helper.
- NEW `src/components/agents-grid.tsx` — Card grid presentational
  component. Server-component-friendly (no hooks).
- NEW `src/components/ui/badge.tsx` — small shadcn-style badge primitive
  with `variant` prop. Tailwind tokens only; no new dependency.
- MODIFIED `src/server/routers/agents.ts` — project the SELECT to the
  six DTO fields explicitly; return type annotated `Agent[]`.
- MODIFIED `app/agents/page.tsx` — render `<AgentsGrid>` instead of
  `<AgentsTable>`; show empty state when list is empty.
- DELETED `src/components/agents-table.tsx` — superseded by
  `<AgentsGrid>`.
- NEW `tests/server/agents-router.test.ts`,
  `tests/lib/agent-status.test.ts`.

## Notes / open questions

- **`last_task_at` formatting** — the column is a SQLite `numeric`/text
  with `CURRENT_TIMESTAMP`-style values (`"2026-05-05 10:23:11"`) or
  daemon-written ISO strings. T03 just renders the raw string. A real
  relative formatter ("2h ago") is **out of scope** — defer to T11
  (empty/error/loading states) or a Phase 2 polish task.
- **20-row FCP < 200ms** is verified in T13 (Playwright). Bun `test`
  cannot measure paint timing without a browser. The data-layer test
  here proves the procedure is O(rows) with no N+1 (single SELECT).
- **Status mapping** mirrors what `bridge_status` exposes today (see the
  daemon's agent state machine). If the daemon adds a state later, the
  helper falls through to `"unknown"` rather than crashing — defensive
  default.
- **Card click → `/agents/[name]`** is part of T04, not T03. Cards in
  T03 are non-interactive; we do not wire a `<Link>` until the detail
  route exists, to avoid a 404-on-click regression.
- **No new dep** — `<Badge>` is a 20-LOC primitive, same pattern as the
  existing `<Card>` / `<Input>` / `<Button>`.
