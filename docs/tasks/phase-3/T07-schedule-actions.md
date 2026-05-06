# P3-T7 — Pause / resume / delete schedule (inline action menu)

> **Loop step 8/11.** Wires the three remaining schedule mutations onto
> the `/schedules` table — `pause`, `resume`, `remove` — closing the
> "manage 5 schedules without ever touching the CLI" PRD goal. Inherits
> the full Phase 3 invariant set from `INDEX.md`.

## Goal

Convert each `/schedules` row from "read-only with cadence label" to
"manageable in two clicks" by inlining:

1. **Pause / Resume button** — flips on the daemon's `enabled`
   column. Reversible (Phase 2 lesson §6 — apply optimistic UI:
   `enabled` toggles instantly; rolls back on a 5xx). Same icon slot
   on every row; the label and the icon swap on `enabled`.
2. **Delete button** — destructive; wraps `<DangerConfirm verb="Delete"
   subject="schedule <name>" expectedConfirmation={schedule.name}>`.
   The user must type the schedule name to enable the action button —
   T7 acceptance "delete requires typing the schedule name". Server-
   confirmed (no optimistic flip; the row may already be gone for the
   next caller).

Phase 2 T11 already shipped `<DangerConfirm>`; Phase 2 T10 already
shipped `runOptimistic`. T7 is the first surface that uses both
together (kill task uses optimistic + danger; cancel loop uses danger
without optimistic — pause/resume is *only* optimistic, no
DangerConfirm, mirroring the design split called out in INDEX §6).

## Files touched

| Path | Status |
|---|---|
| `src/server/dto.ts` | +12 (`ScheduleMutationResult`) |
| `src/server/routers/schedules.ts` | +180 (`pause`, `resume`, `remove` procedures + helpers) |
| `src/lib/schedule-action-client.ts` | new — pure browser helpers |
| `src/components/schedule-row-actions.tsx` | new — client island per row (pause / resume / delete) |
| `src/components/schedule-table.tsx` | edit — add "Actions" column rendering `<ScheduleRowActions>` |
| `tests/server/schedules-router.test.ts` | edit — extend with pause/resume/remove test cases |
| `tests/lib/schedule-action-client.test.ts` | new — request-builder + envelope-decoder coverage |
| `tests/app/schedule-row-actions.test.ts` | new — view-state matrix |
| `docs/tasks/phase-3/T07-schedule-actions.md` | new — this file |
| `docs/tasks/phase-3/T07-review.md` | new — code review |

## Wire shape — `schedules.pause` / `schedules.resume` / `schedules.remove`

All three share the same input + result shape so the client helper can
be a single `buildScheduleActionRequest(action, …)` factory.

```ts
// server input — identical for all three
id: z.number().int().positive()

// server output — identical for all three
type ScheduleMutationResult = { ok: true }
```

Idempotency / not-found semantics:

| Path | Trigger | Audit row | MCP called? |
|---|---|---|---|
| A. unknown id | row not in `schedules` table | `schedule.<action>.error`, `payload={ id, code: "NOT_FOUND" }` | ❌ |
| B. happy path | row exists, daemon accepts | `schedule.<action>`, `payload={ id, name, agentName, ...delta }` | ✅ |
| C. daemon error | `McpPoolError` (any code) | `schedule.<action>.error`, `payload={ id, code }` | ✅ (raised) |
| D. malformed daemon | unparseable response | `schedule.<action>.error`, `payload={ id, code: "malformed_response" }` | ✅ |

The daemon's `bridge_schedule_<action>` tools accept a `name_or_id`
string parameter. We always pass `String(id)` (the numeric `id` from
the dashboard side) so the daemon path is unambiguous — passing
`name` would race a hypothetical schedule rename that we don't
support today but might.

The `pause` and `resume` procedures look up the row first (so we can
audit its `name` + `agentName` for forensics) and short-circuit `404`
when the row is gone. The lookup is a single Drizzle `select().limit(1)`
— same shape as `lookupLoop` in `loops.cancel`. No extra MCP round-trip.

## Daemon-side context

`bridge_schedule_pause({ name_or_id })`, `bridge_schedule_resume({
name_or_id })`, `bridge_schedule_remove({ name_or_id })` — all listed
in `claude-bridge/src/mcp/tools.ts:300-340`. None take optional
arguments. The daemon's CLI fallback is `["schedule", "{pause,resume,
remove}", String(name_or_id)]` — all return a text envelope on
success and throw on unknown id. The dashboard treats throw-on-
unknown as the daemon's standard `MCP_RPC_ERROR`; we already mapped
that to `INTERNAL_SERVER_ERROR` in T6's error matrix.

The daemon's reply for these three is text-only (no structured `{ id }`
echo): we accept any non-throwing response as "ok" — the procedure
does not need to parse anything out of the envelope.

## UX decisions

### Why a per-row client island (not a single page-level handler)

The `/schedules` page is a server component that calls
`appRouter.createCaller({}).schedules.list()` and hands the rows down.
The actions need `useState` (in-flight badge, error toast) and
`useRouter().refresh()` to invalidate the page after the mutation. We
isolate that state in a `<ScheduleRowActions>` client island
mounted inside each row's `<td>`, mirroring the
`<LoopControls>` shape from T4. The page remains a server component;
no `"use client"` directive at the page level.

### Why optimistic on pause/resume but NOT on delete

Phase 3 INDEX §"Optimistic UI scope decision" (carrying Phase 2 §d.1
forward) is explicit: pause/resume are reversible — applying the
optimistic flip and rolling back on 5xx is visibly faster. Delete is
destructive — an optimistic flip would briefly hide a row that may
turn out to still exist (5xx, race with another tab pressing Pause
on the same id), and the user-visible "row reappears" rollback is
worse than the 200ms server round-trip.

### Why the delete confirmation token is the schedule name (not the id)

Phase 2 T11 used "agent name" for kill (humans recognise their
agents); Phase 3 T4 used "loop_id 8-char prefix" for cancel
(humans don't pre-name loops). For schedules, the dashboard always
shows a daemon-assigned `name` (auto-generated when the user omits
it) — typing the name is more friendly than typing a number, and the
daemon enforces uniqueness within an agent so the token is
sufficiently specific. Same pattern as the v1 P3-T7 acceptance:
"delete requires typing the schedule name".

### Why the icon-button trio (vs an overflow menu)

A "kebab" menu (`⋯` → dropdown of {Pause, Delete}) is the typical
spreadsheet shape. We render the three actions inline as icon
buttons because: (1) at typical scale (the PRD targets 5 schedules)
they fit horizontally without crowding; (2) every row exposes the
same one-click affordance — no two-click hover-then-pick;
(3) accessibility — direct buttons are keyboard-reachable in tab
order; a dropdown menu would need ARIA roving focus + escape-to-
close. The trade-off is row-width: the actions column adds ~120 px,
which the existing table layout absorbs.

### Why no `<DangerConfirm>` on pause / resume

Phase 3 INDEX is explicit: pause/resume are reversible — wrapping
DangerConfirm here would gate every flip behind a typed-name
confirmation, which is hostile UX for an action the user can
trivially undo by clicking the opposite button. Delete is the only
schedule action that destroys state.

### Why we audit `name` and `agentName` even though they're on the row

Phase 2 T04 audit-payload precedent: include the human-readable
identifier alongside the numeric id so `/audit` can render
"`schedule.pause` schedule#42 — alpha/nightly-tests" without joining
back to the (potentially-deleted-after-the-fact) schedules table.
Same rule we apply to `tasks.kill` (carries `agentName` even though
the row also has `id`).

## Acceptance criteria — pinned by tests

- [x] `schedules.pause({ id })` → MCP `bridge_schedule_pause({
      name_or_id: String(id) })`. Audit row `schedule.pause` with
      `payload={ id, name, agentName }`.
- [x] `schedules.resume({ id })` → MCP `bridge_schedule_resume(...)`.
      Audit row `schedule.resume`.
- [x] `schedules.remove({ id })` → MCP `bridge_schedule_remove(...)`.
      Audit row `schedule.remove`. Server does NOT delete the row
      itself — daemon owns the lifecycle.
- [x] Unknown `id` → `NOT_FOUND` thrown without MCP call;
      `schedule.<action>.error` audit row with `code=NOT_FOUND`.
- [x] Daemon throw → `mapMcpErrorToTrpc(err)` re-raised; audit row
      `schedule.<action>.error` carries the `McpPoolError.code`.
- [x] Privacy: prompt text NEVER appears in audit payload (the row
      lookup pulls `prompt` for the daemon ack but the audit payload
      omits it). Schedule `name` IS audited (it's the user-given
      label, not free-form content).
- [x] CSRF middleware applies (route-level) — verified by existing
      `tests/server/csrf-guard.test.ts`.
- [x] Rate-limit middleware applies (route-level) — same.
- [x] Audit row carries `request_id` per Phase 2 lesson §4.
- [x] Audit row uses `resource_type=schedule`, `resource_id=String(id)`.
- [x] Pause / resume buttons render as inline icon buttons; switching
      `enabled` flips the icon + label.
- [x] Delete button wraps `<DangerConfirm verb="Delete" subject=...>`
      with `expectedConfirmation` set to the schedule `name`.
- [x] Pause / resume runs through `runOptimistic` (P2-T10): the icon
      flips synchronously, rolls back if the request rejects.
- [x] After pause/resume/delete resolves, the page invokes
      `router.refresh()` so the next render reflects the daemon's
      finalized state.
- [x] `bun run test` (existing 817 + new T7 cases) all pass.
- [x] `bun run build` produces a clean Next.js bundle —
      `/schedules` route grows by the small `<ScheduleRowActions>`
      island.

## Out of scope / follow-ups

- **Schedule detail page.** `/schedules/[id]` is not on the Phase 3
  task list; T8 ships the run-history drawer next, which is the
  closest equivalent. A standalone detail page is filed against
  Phase 4.
- **Bulk select / multi-pause.** The PRD targets ≤5 schedules per
  deployment; bulk operations are not in scope. If a deployment
  grows past that, an "Apply to all" affordance is a follow-up.
- **SPA-click E2E for the action menu.** Phase 3 INDEX test surface
  plan keeps the contract-level pattern (network assertions on tRPC
  envelopes); SPA-click coverage stays deferred per Phase 2
  follow-up §5. The Playwright `schedule-pause-delete.spec.ts`
  covers the request shape end-to-end.
- **Optimistic UI feedback for delete.** Delete is server-confirmed
  by design (see UX decisions §2); the row stays visible during the
  ~200ms round-trip. If a deployment ever surfaces this as a
  complaint, a "Deleting…" overlay would close the gap without
  flipping to optimistic-removal.
