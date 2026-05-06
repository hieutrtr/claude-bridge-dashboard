# P3-T1 — `loops.list` router + `/loops` page

> Read-only vertical-slice entry into the loops vertical. Replaces
> the `/loops` placeholder shipped in Phase 1 with a paginated,
> filterable table backed by a new `loops.list` tRPC query.

## Scope

- **Router** — extend `src/server/routers/loops.ts` with one new
  query procedure, `list({ status?, agent?, cursor?, limit? })`,
  reading directly from the vendored `loops` table (`src/db/schema.ts`).
  No MCP call, no audit row (queries are not audited per Phase 2
  scope decision).
- **DTO** — add `LoopListRow` + `LoopListPage` to `src/server/dto.ts`.
  Curated subset of the daemon `loops` table; the `goal` text is
  intentionally NOT projected onto the wire (privacy precedent §c).
- **Helper** — `src/lib/loop-status.ts` exports `loopStatusBadge`,
  same shape as `taskStatusBadge` / `agentStatusBadge`. Returns the
  existing `<Badge>` variants.
- **Components** — `src/components/loop-filters.tsx` (URL-as-truth
  `<form method="get">`, no `"use client"`) and
  `src/components/loop-table.tsx` (presentational; row → detail
  page link).
- **Page** — replace `app/loops/page.tsx` with the server component
  that wires the filter strip + table to `loops.list`. URL params
  are the single source of truth: `?status=…&agent=…&cursor=…`.

## Wire shape

```ts
loops.list({
  status?: string,    // "running" | "done" | "cancelled" | "failed" | "waiting_approval"
  agent?:  string,    // exact match against agents.name
  cursor?: string,    // started_at ISO of the oldest row on the previous page
  limit?:  1..100,    // default 50
}) → {
  items: LoopListRow[],
  nextCursor: string | null,
}
```

`LoopListRow` projects: `loopId, agent, status, loopType,
currentIteration, maxIterations, totalCostUsd, maxCostUsd,
pendingApproval, startedAt, finishedAt, finishReason`.

`status="waiting_approval"` is a synthetic sentinel — the daemon keeps
`loops.status="running"` while a human gate is pending; the router
maps the sentinel to `pending_approval=true`.

## Acceptance

1. `loops.list({})` over an empty DB returns `{ items: [], nextCursor: null }`.
2. Rows are ordered by `started_at` DESC.
3. `cursor=<started_at>` returns rows strictly older than the cursor;
   pagination terminates with `nextCursor=null` on the final page.
4. `status` + `agent` combine via AND. Unknown agent → empty page.
5. `status="waiting_approval"` returns only loops with
   `pending_approval=true`, regardless of `loops.status`.
6. Wire payload does NOT include the `goal` column (privacy
   precedent — same rule the audit log applies to dispatch prompts
   and reject reasons).
7. `/loops` page filter strip submits via `<form method="get">`;
   submitting drops the `cursor` param implicitly (jumps back to
   page 1). URL is the single source of truth.
8. Empty / loading / error states reuse Phase 1 T11 primitives via
   the `<Card>` / `<CardContent>` empty-state pattern.
9. Table renders 100 loops without virtualization (well below the
   v1 ARCH §11 threshold).

## Tests

| File                                    | Coverage                                                   |
|-----------------------------------------|------------------------------------------------------------|
| `tests/server/loops-router.test.ts`     | Empty DB / ordering / wire shape / privacy / filters / pagination / input validation. 18 new test cases extending the existing approve+reject coverage. |
| `tests/app/loops-page.test.ts`          | Module surface (no POST/PUT/PATCH/DELETE), empty + filtered-empty states, populated table (badge / budget / iter), `Waiting approval` synthetic mapping, uncapped budget formatting, filter-strip default values, privacy (no goal text in HTML). 11 cases. |

Both files exercise `appRouter.createCaller` against an isolated
on-disk SQLite DB (mirrors the existing `loops-router.test.ts`
pattern). The page test renders via `react-dom/server`'s
`renderToStaticMarkup`.

## Out-of-scope (handled in later iters)

- **SSE live updates** — INDEX §`Caveat`: T2 will poll every 2s;
  a multiplexed `/api/stream` for loops + tasks + agents is filed
  against Phase 4. T1 stays statically rendered.
- **Detail page** — `/loops/[loopId]` lands in T2 (timeline +
  cumulative-cost sparkline).
- **Start dialog** — T3 adds the "Start loop" button + `<Dialog>`.
- **Cancel / approve / reject inline** — T4.

## Files touched

- `src/server/dto.ts` — `LoopListRow` + `LoopListPage` interfaces.
- `src/server/routers/loops.ts` — new `list` query + `ListInput` +
  `LIST_DTO_SELECTION`.
- `src/lib/loop-status.ts` — new `loopStatusBadge` helper.
- `src/components/loop-filters.tsx` — new (URL-as-truth filter strip).
- `src/components/loop-table.tsx` — new (presentational table).
- `app/loops/page.tsx` — replace placeholder with server-rendered
  list page.
- `tests/server/loops-router.test.ts` — extended with `loops.list`
  describe blocks.
- `tests/app/loops-page.test.ts` — new component test.

## Risk / lessons

- **Risk: Low**. Read-only query; the PII guard (no goal column on
  the wire) is unit-tested. No mutation surface, so the Phase 3
  invariant checklist (CSRF / rate-limit / audit / DangerConfirm /
  optimistic) is N/A for this task — exhaustively N/A, see review.
- **Lesson** — the synthetic `status="waiting_approval"` mapping is
  worth a comment in both the router and the filter component;
  without it a reader assumes `status` is a 1:1 column passthrough
  and gets confused why `waiting_approval` doesn't appear in
  `loops.status`. Comment lives at the input-schema definition in
  `loops.ts` plus a one-liner in `loop-filters.tsx` STATUS_OPTIONS.
