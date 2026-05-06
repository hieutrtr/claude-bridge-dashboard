# P3-T4 — Cancel + Approve / Deny gate UI on `/loops/[loopId]`

> **Loop step 5/11.** Surfaces the three loop-detail-page mutations
> (cancel, approve, reject) on the page Phase 1 wired but Phase 2
> only fronted with task-detail-side controls. **Inherits all Phase 3
> invariants** from `INDEX.md`: every mutation goes through the
> daemon's MCP pool, carries CSRF + rate-limit, audits before
> returning, and (for cancel only) wraps a `<DangerConfirm>` from
> Phase 2 T11.

## Goal

Convert the `/loops/[loopId]` page from "read-only timeline" to
"actionable command surface" by inlining:

1. **Cancel-loop button** — `loops.cancel` mutation backed by the
   daemon's `bridge_loop_cancel` MCP tool. Wrapped in `<DangerConfirm
   verb="Cancel" subject="loop XXXXXXXX…" expectedConfirmation=<8-char
   prefix>>`. Suppressed when the loop is already in a terminal status.
2. **Approve / Deny gate** — re-uses the existing `loops.approve` /
   `loops.reject` mutations from Phase 2 T06. Adds **large** buttons
   (`h-14`, large font) per v1 acceptance "Allow/Deny lớn", a 1-click
   Approve, and a small inline reason textarea for Deny.

Phase 2 T06 wired approve/reject only on the task-detail page (via
`<PermissionRelayToast>`). Phase 3 brings them to the loop-detail page
without duplicating the procedure — the new components hit the
existing tRPC endpoints.

## Files touched

| Path | Status |
|---|---|
| `src/server/dto.ts` | +12 (`LoopCancelResult`) |
| `src/server/routers/loops.ts` | +120 (`CancelInput`, `TERMINAL_LOOP_STATUSES`, `cancel` procedure) |
| `src/lib/loop-mutation-client.ts` | new — 119 (cancel/approve/reject browser helpers) |
| `src/components/loop-cancel-button.tsx` | new — 90 (DangerConfirm wrapper) |
| `src/components/loop-approval-gate.tsx` | new — 257 (View + wrapper) |
| `src/components/loop-controls.tsx` | new — 67 (router-refresh shim) |
| `app/loops/[loopId]/page.tsx` | +6 (mounts `<LoopControls>`) |
| `tests/server/loops-router.test.ts` | +266 (26 new cancel cases) |
| `tests/lib/loop-mutation-client.test.ts` | new — 9 cases |
| `tests/app/loop-cancel-button.test.ts` | new — 8 cases |
| `tests/app/loop-approval-gate.test.ts` | new — 12 cases |

## Wire shape — `loops.cancel`

```ts
// server input
loopId: z.string().min(1).max(128)

// server output
type LoopCancelResult = { ok: true; alreadyFinalized: boolean }
```

`alreadyFinalized=true` shape (mirrors approve/reject from T06):

| Path | Trigger | Audit row | MCP called? |
|---|---|---|---|
| A. server-side terminal-status | `loop.status ∈ {done, cancelled, canceled, failed}` | `loop.cancel`, `payload={status, alreadyFinalized:true}` | ❌ |
| B. daemon-side race | `MCP_RPC_ERROR` body matches `LOOP_RACE_PATTERN` | `loop.cancel`, `payload={status, alreadyFinalized:true, raceDetected:true}` | ✅ (raised) |
| C. happy path | `pending_approval=true` or running | `loop.cancel`, `payload={status, alreadyFinalized:false}` | ✅ |
| D. genuine error | non-race `McpPoolError` or non-MCP throw | `loop.cancel.error`, `payload={status, code}` + TRPCError | ✅ (raised) |

## Daemon-side context

`bridge_loop_cancel({ loop_id })` — listed in `CLAUDE.md`. No optional
arguments. Server- and daemon-side both treat repeated cancels as
benign — the early-return pattern from T06 carries over verbatim.

## UX decisions

### Why split `LoopControls` from the page

The page (`app/loops/[loopId]/page.tsx`) is a server component (it
`await`s the in-process tRPC caller). It cannot use `useState`,
`useRouter`, `useEffect`. The two new controls are interactive, so
they live in a single sibling client component (`loop-controls.tsx`)
that owns the router-refresh closure shared by both. This mirrors
the Phase 2 pattern of `<KillTaskButton>` rendering inside
`<TaskKillControl>`.

### Why `useRouter` is wrapped in try/catch

`renderToStaticMarkup` (used by `tests/app/loop-detail.test.ts`) does
not provide an `AppRouterContext`, so a naive `useRouter()` call
throws "invariant expected app router to be mounted". We wrap the
call in try/catch and degrade gracefully to `window.location.reload()`
for the SSR-test path. In real Next.js renders the catch is dead code.

### Why approve/reject are NOT wrapped in `<DangerConfirm>`

Phase 3 INDEX explicitly carves this out: approve/reject **advance**
the loop, they do not **destroy** state. The race-window vs Telegram
already neutralizes accidental double-clicks (the second click sees
`alreadyFinalized:true`). Adding a DangerConfirm here would break
the v1 acceptance "Allow/Deny lớn" — the dialog would *replace* the
big button, not gate it.

Cancel **is** destructive — wrap with `<DangerConfirm verb="Cancel"
subject="loop XXXXXXXX…" expectedConfirmation={loopId.slice(0, 8)}>`.
The 8-char prefix is the deliberate ergonomic floor (typing 36 chars
of UUID on a phone is hostile, per Phase 2 T11 §4 review).

### Why approve has no reason field but reject does

Approve is "yes, continue" — there is nothing for the next iteration
to know. Reject takes an optional `reason` that the daemon forwards
to the agent as `feedback` (Phase 2 T06 §c). Audit logs `hasReason`
sentinel only; the textarea label warns the user that the reason text
is forwarded to the daemon but **not** logged in the audit trail
(privacy precedent §c).

### Why no optimistic UI

Per Phase 3 INDEX §"Optimistic UI scope decision": cancel + approve +
reject are server-confirmed because the Telegram race is real.
Optimistic flip would surface a 100ms-stale state on the dashboard
when Telegram pre-empts. We instead call `router.refresh()` after
the resolved promise so the next server render reflects the daemon
state of record.

## Acceptance criteria — pinned by tests

- [x] Cancel + 8-char-prefix typed-confirmation enables the action
      button (T11 contract — exercised via `<DangerConfirm>` view tests).
- [x] Cancel-on-terminal-status is a no-op with `alreadyFinalized:true`
      and skips the MCP call (server tests, 4 status cases).
- [x] Cancel race regex covers all 9 daemon phrasings of "already
      finalized" (server tests).
- [x] Cancel does NOT swallow generic MCP_RPC_ERROR (e.g. agent panic
      message) — `INTERNAL_SERVER_ERROR` + `loop.cancel.error` audit row
      with `code=MCP_RPC_ERROR`.
- [x] Cancel + Approve + Reject are NEVER reachable for unknown
      `loopId` — `NOT_FOUND` thrown without audit row or MCP call.
- [x] Approve and Deny render as **large** buttons (`h-14`) when
      `pending_approval=true` (component tests check `h-14` markup).
- [x] Deny opens a small inline reason form; reason ≤ 1000 chars
      enforced both client (visual) and server (Zod). Excess chars red-
      border + disabled submit.
- [x] After approve / reject / cancel resolves, the page invokes
      `router.refresh()` so the next render reflects the daemon's
      finalized state.
- [x] CSRF middleware applies (route-level) — verified by
      `tests/server/csrf-guard.test.ts` covering all `/api/trpc/*`
      POSTs uniformly.
- [x] Rate-limit middleware applies (route-level) — same uniformity.
- [x] Audit row carries `request_id` per Phase 2 lesson §4.
- [x] Audit row uses `resource_type=loop`, `resource_id=loopId`.
- [x] `bun run test` (709 tests, 61 files) all pass.
- [x] `bun run build` produces a clean Next.js bundle —
      `/loops/[loopId]` route size 0 KB → 2.92 kB (the new client
      island).

## Out of scope / follow-ups

- **SPA-click E2E for the loop-detail controls.** Phase 3 INDEX
  test surface plan keeps the contract-level pattern (network
  assertions on tRPC envelopes); the SPA click stays deferred per
  Phase 2 follow-up §5.
- **Loop iteration SSE.** The page still polls (server-render-on-nav).
  Multiplexed `/api/stream` is filed against Phase 4 per Phase 2
  follow-up note §3.
- **Approve / reject also reachable from `/loops` row.** v1 plan's
  "Approve / Deny lớn" wording suggests the loop-detail page; the
  list page only badges "Waiting approval". A future follow-up could
  add a row-level quick-approve, but doing so duplicates the gate UX
  and risks accidental approvals from a glance — left out
  intentionally.
