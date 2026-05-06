# P3-T1 — Code review

> Self-review against the Phase 3 invariant checklist (INDEX §
> "Phase 3 invariant — INHERITED FROM PHASE 2") and the v1 P3-T1
> acceptance bullets. Read-only task → most invariant rows are
> "N/A by design" rather than satisfied.

## Phase 3 mutation invariant — applicability

| # | Invariant                            | Status   | Reason                                                                 |
|---|--------------------------------------|----------|------------------------------------------------------------------------|
| 1 | Mutation routes through MCP          | **N/A**  | `loops.list` is a query (`publicProcedure.query`), no mutation surface |
| 2 | Travel through MCP pool              | **N/A**  | No MCP call                                                            |
| 3 | CSRF double-submit token             | **N/A**  | tRPC GET; CSRF guard runs on POST mutations only (Phase 2 T08)         |
| 4 | Rate-limit token bucket              | **N/A**  | Same — bucket binds to mutation POSTs (Phase 2 T07)                    |
| 5 | `appendAudit` before return          | **N/A**  | Queries are not audited per Phase 2 scope decision                     |
| 6 | DangerConfirm wrap                   | **N/A**  | No destructive action                                                  |

The "N/A by design" rationale is documented inline in the task spec
(`T01-loops-list.md` §Risk) and in the page-level docstring on
`app/loops/page.tsx`.

## Privacy review

- ✅ **Goal text not on the wire**. `LIST_DTO_SELECTION` does not
  include `loops.goal`. A targeted unit test seeds
  `goal="SECRET_GOAL_TEXT_DO_NOT_LEAK"` and asserts the JSON-
  stringified row never contains the substring. Same precedent T06
  set for `reason` in Phase 2 (`hasReason: true` rather than
  echoing).
- ✅ **No prompt / no done_when text** projected. Both columns are
  similarly omitted; only the high-level metadata (status,
  iteration count, cost) reaches the client.
- ✅ **`/loops` page renders only DTO columns**. The page-level
  privacy assertion (`expect(html).not.toContain("SECRET_GOAL…")`)
  catches any future regression where the table starts echoing the
  goal column.

## Input validation

- ✅ `status` requires `min(1)` — empty strings rejected with
  `BAD_REQUEST` (avoids accidental "match all" via empty-string
  filter on the URL).
- ✅ `agent` requires `min(1)` — same.
- ✅ `limit` clamped at `[1, 100]` — over-limit rejected with
  `BAD_REQUEST`.
- ✅ `cursor` requires `min(1)` — empty cursor rejected so a
  client-side bug emitting an empty string doesn't degrade to "no
  cursor" semantics silently.

## SQL surface

- ✅ Single `SELECT … FROM loops WHERE … ORDER BY started_at DESC
  LIMIT n` per request, paginated.
- ✅ Cursor is `started_at < ?` (strict less-than). `started_at` is
  TEXT in the daemon schema and ISO-8601 sorts identically to
  natural date order under SQLite lex comparison. Same pagination
  shape as `tasks.list` (Phase 1 T05 — there `id < ?` because tasks
  has an INTEGER PK; loops has a TEXT PK so we use the timestamp).
- ✅ Filter clauses bind via Drizzle parameter substitution; no
  string-concat SQL.
- ✅ Indexed: `idx_loops_agent` covers the `agent=?` filter;
  `idx_loops_status` covers `status=?`. The
  `pending_approval=true` filter falls back to a full table scan,
  but the table is small (loops are coarse-grained — typically <
  100 rows even on heavily-loaded daemons) and the filter is
  combined with `started_at` ordering which would dominate the
  query plan anyway. Acceptable per v1 ARCH §11 perf budget.

## URL-as-truth contract

- ✅ Filter strip is `<form method="get">` — no React state, no
  `"use client"`. Submitting jumps to page 1 (cursor dropped).
- ✅ "Next →" link carries `cursor=` plus all current filter
  params via `buildSearchString`. Mirrors the
  `<GlobalTaskTable>` shape from Phase 1 T05.
- ✅ "Clear" link is a plain `<Link href="/loops">`.

## Empty / loading / error states

- ✅ Empty (no filters) → "No goal loops have been started yet"
  copy with a CLI hint.
- ✅ Empty (filtered) → "No loops match the current filters" copy
  with an explicit `<Link>` back to `/loops`.
- ✅ Loading → reuses the existing `app/loops/loading.tsx`? — Phase
  1 stub has `app/loops/page.tsx` only, no `loading.tsx`. Next.js
  falls through to the parent `app/loading.tsx` (Phase 1 T11). No
  Phase 3 regression — verified the file is untouched.
- ✅ Error → tRPC-side `BAD_REQUEST` propagates as a Next.js error
  boundary; no try/catch needed at the page level.

## Wire-shape stability

- ✅ Two distinct types `LoopListRow` + `LoopListPage` so a future
  per-row extension (e.g. surfacing iteration timing metadata)
  doesn't ripple onto the page-level cursor type.
- ✅ Numeric / nullable contract documented in dto.ts: `maxCostUsd`
  is nullable (uncapped), `totalCostUsd` is `NOT NULL` (defaults to
  0). Row formatter handles the mix via `formatBudget`.

## Out-of-scope confirmation

The following Phase 3 surface is **explicitly NOT touched** by T1
and stays consistent with the iteration mapping in INDEX §
"Iteration mapping":

- T2 — loop detail page (renders inside `/loops/[loopId]`)
- T3 — `loops.start` mutation + Start dialog
- T4 — cancel / approve / reject inline controls
- Phase 4 — multiplexed `/api/stream` for loop iter events

## Test coverage summary

- **18 new router tests** in `tests/server/loops-router.test.ts`.
  Existing 32 approve+reject tests untouched.
- **11 new page tests** in `tests/app/loops-page.test.ts`.
- **Unit math tests for `loopStatusBadge`** are bundled via the
  page tests (each badge variant gets exercised against a
  representative row); a standalone `loop-status.test.ts` would
  duplicate coverage so I kept the surface tight per Phase 2
  lesson §1.
- **`bun run build`** clean (8 routes, 0 errors).
- **`bun test tests/lib tests/app tests/server`** → **587 pass / 0
  fail** (preserved baseline + 29 new tests, total 587 — the
  baseline before T1 was 558 according to commit
  `5fb71c9`).

## Follow-ups for next iters

- **T2** will need a one-row `loops.get(loopId)` query — easy to
  add to this same router file; reuses the SELECTION pattern.
- **T4** will append the `cancel` mutation; the
  `LOOP_RACE_PATTERN` regex (already in this file from T06) covers
  the cancel race too.
- **T3** Start dialog will reuse the same `<Dialog>` primitive
  pattern as Phase 2 T02 dispatch dialog. No new primitives needed.
