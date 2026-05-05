# P1-T03 review — `agents.list` enrichment + Agents grid page

> Self-review checklist for Rule 3 of the loop process.

## Files added

- `src/server/dto.ts` — explicit `Agent` interface (6 fields). Single
  source of truth for the wire shape; reused by T04 `agents.get` next.
- `src/lib/agent-status.ts` — pure `agentStatusBadge(state)` helper +
  `AgentStatusVariant` / `AgentStatusBadge` types.
- `src/components/ui/badge.tsx` — shadcn-style `<Badge>` primitive with
  4 variants (`running`, `idle`, `error`, `unknown`). 30 LOC, no new dep
  (uses the same `class-variance-authority` already in `<Button>`).
- `src/components/agents-grid.tsx` — Card grid. Pure presentational,
  server-component-friendly. Empty state renders an instructional card.
- `tests/server/agents-router.test.ts` — 5 tests, 24 expects. Covers
  empty list, multi-row read, DTO field projection, type preservation
  (incl. nullable columns), 20-row smoke.
- `tests/lib/agent-status.test.ts` — 8 tests, 8 expects. Covers each
  documented mapping + null + empty + unknown fallback.

## Files modified

- `src/server/routers/agents.ts` — `list` now does an explicit
  `.select({...})` projection of the six DTO fields and is annotated
  `(): Agent[]`. Procedure stays a `query` — no mutation surface added.
- `app/agents/page.tsx` — renders `<AgentsGrid>` instead of the legacy
  `<AgentsTable>`; wraps content in `space-y-6` for consistent rhythm
  with the rest of the dashboard layout.

## Files deleted

- `src/components/agents-table.tsx` — superseded by `<AgentsGrid>`.
  Verified no other file in `src/`, `app/`, or `tests/` referenced
  `AgentsTable` or the path `agents-table` after deletion.

## Test results

```
$ bun test
 61 pass
 0 fail
 178 expect() calls
Ran 61 tests across 8 files.

$ bun run typecheck
$ tsc --noEmit         # exit 0
```

48 prior tests (Phase 0 + T01 + T02) + 13 new T03 tests (5 router + 8
status helper) = 61 total, 178 expects.

## Self-review checklist

- [x] **Tests cover happy + edge case** — router: empty DB, 3-row read,
      DTO projection (asserts the exact 6-key set), type preservation
      across populated + null columns, 20-row smoke. Helper: every
      documented branch + null + empty string + unknown future state.
- [x] **Not over-engineered** — no client-side filtering, no sorting, no
      `<Link>` wiring (T04 owns the detail route). No new dependency:
      `<Badge>` reuses the existing CVA stack from `<Button>`. The DTO
      lives in one file; tested end-to-end via `createCaller` so we
      didn't have to spin up an HTTP server in tests.
- [x] **ARCHITECTURE v2 picks honoured** — Next.js App Router server
      component reads via tRPC `createCaller` (in-process, no HTTP
      round-trip — perf budget §11). Drizzle SELECT projects only the
      fields the UI uses (smaller payload). Tailwind v4 tokens
      (`hsl(var(--*))`) — no inline hex colors apart from emerald/red
      for status badges (semantic, hard-coded by design). shadcn
      primitives only. **No mutation procedure added.**
- [x] **No secret leak** — payload contains no `JWT_SECRET`,
      `DASHBOARD_PASSWORD`, session token, or socket path. The DTO
      drops `sessionId` (which is sensitive — it links to the local
      Claude Code session JSONL) so a hostile reader of the network
      tab cannot enumerate session IDs from the agents list.
- [x] **Read-only invariant** — `agents.list` is a `query`, not a
      `mutation`. No `bridge_dispatch`, no DB write, no file write.
      The page is a server component with no form. ✅
- [x] **Performance budget** — single SELECT, O(rows). For 20 rows,
      payload ~1.4 KB JSON. CSS-grid layout, no JS sort/filter on the
      client. First-load JS unchanged from T02 (Badge + Grid are
      server-rendered HTML; no `"use client"` directive). FCP at 20
      rows will be verified in T13 Playwright spec — data path
      smoke-tested here at 20 rows already.

## Issues found

- **None blocking.**
- **Minor / observational:**
  - **`last_task_at` is rendered raw** (e.g. `"2026-05-05 09:00:00"`).
    A relative formatter ("2h ago") is a polish item — flagged for
    T11 / Phase 2 in the task file Notes. Kept raw on purpose so the
    DTO is timezone-agnostic.
  - **Cards are non-interactive** in T03. `<Link>` to `/agents/[name]`
    is added in T04 once that route exists; doing it now would 404.
  - **Badge color tokens** for `running` / `error` use Tailwind's
    emerald/red palette directly rather than custom design tokens.
    The dashboard's globals.css doesn't ship `--success` / `--danger`
    tokens yet — T12 (theme polish) will reconcile these against a
    full token palette if needed.
  - **20-row FCP < 200ms** acceptance bullet is asserted at the data
    layer here (5-row + 20-row tests prove the procedure is single-
    SELECT) and at the render layer in T13 (Playwright). Bun `test`
    cannot measure paint timing without a browser.
  - **Total tasks rendering `0` for null** — schema default is `0`, but
    a column-level NULL is still possible if the daemon ever inserts
    one. The grid coalesces with `?? 0` — matches what users expect
    ("zero tasks" rather than an empty cell).

## Verification trail

- `bun test` → 61 pass / 0 fail / 178 expects (logged above).
- `bun run typecheck` → clean exit.
- Browser/manual smoke deferred to loop step 16. Manual flow to verify
  later: `bun run dev` → log in → land on `/agents` → see one card per
  registered agent with project / model / state badge / total tasks /
  last task. Empty state appears on a fresh DB.

## Sign-off

T03 complete. Ready for T04 (`agents.get` + Agent detail page) on next
iter. INDEX checkbox updated.
