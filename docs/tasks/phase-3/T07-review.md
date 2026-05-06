# P3-T7 — pause / resume / delete schedule (inline action menu): code review

> Reviewer's pass over the T7 deliverables before commit. T7 ships
> three sibling mutations (`pause`, `resume`, `remove`) plus the
> per-row client island that surfaces them. All three carry the full
> Phase 3 invariant set (CSRF / rate limit / audit / no direct table
> writes / privacy / `request_id`).

## Files touched

| Path | Status | Lines |
|---|---|---|
| `src/server/dto.ts` | edit | +12 (`ScheduleMutationResult`) |
| `src/server/routers/schedules.ts` | edit | +127 (input schema + lookup helper + `makeScheduleActionProcedure` + 3 router bindings) |
| `src/lib/schedule-action-client.ts` | new | 95 |
| `src/components/schedule-row-actions.tsx` | new | 226 |
| `src/components/schedule-table.tsx` | edit | +14 (Actions header column + per-row `<ScheduleRowActions>` mount) |
| `tests/server/schedules-router.test.ts` | edit | +210 (28 new cases — happy / validation / not-found / mcp-error matrix / context-missing) |
| `tests/lib/schedule-action-client.test.ts` | new | 10 cases |
| `tests/app/schedule-row-actions.test.ts` | new | 11 cases |
| `docs/tasks/phase-3/T07-schedule-actions.md` | new | task spec |
| `docs/tasks/phase-3/T07-review.md` | new | this file |

## Phase 3 invariant checklist (all three mutations)

### 1. Calls daemon MCP (no direct table writes) — ✅
- `schedules.pause`, `.resume`, `.remove` each invoke
  `ctx.mcp.call("bridge_schedule_<action>", { name_or_id: String(id) })`
  via the Phase 2 T12 pool. No `UPDATE` / `DELETE` against the
  `schedules` table from the dashboard side — the daemon owns
  schedule lifecycle.
- The lookup-then-call ordering is preserved: `lookupSchedule(id)` is
  a SELECT-only Drizzle query (`select … from schedules where id = ?
  limit 1`) used solely to (a) short-circuit unknown ids without a
  daemon round-trip and (b) capture `name` + `agentName` for the
  audit payload.
- Missing MCP context → `INTERNAL_SERVER_ERROR` with no audit row,
  same guard shape as `tasks.dispatch`, `loops.start`, `schedules.add`.

### 2. CSRF guard — ✅
- POST → `csrfGuard` runs in `app/api/trpc/[trpc]/route.ts` before
  any mutation procedure. The client island reads
  `bridge_csrf_token` cookie via `readCsrfTokenFromCookie(document
  .cookie)` and forwards the value in the `x-csrf-token` header on
  every fetch.
- CSRF-missing UX flips `csrfMissing=true` and disables both
  buttons — pinned by the view test `disables both triggers when
  csrfMissing=true (session expired)`.

### 3. Rate limit — ✅
- Same 30-mutations/min/user bucket as Phase 2 — applied at the
  route handler via `rateLimitMutations`. No router-level work; the
  shared bucket covers `schedules.pause/resume/remove` automatically
  via `tests/app/trpc-rate-limit-route.test.ts`.

### 4. Audit log — ✅
- `appendAudit({ ctx, action, resourceId, payload })` runs on **every
  exit path**:
  - Success → `action="schedule.<action>"`, `resourceId=String(id)`,
    payload `{ id, name, agentName }`.
  - Unknown id → `action="schedule.<action>.error"`, payload
    `{ id, code: "NOT_FOUND" }`.
  - MCP error → `action="schedule.<action>.error"`, payload
    `{ id, name, agentName, code }` where `code` comes from
    `auditFailureCode(err)`.
  - Validation failure → no audit (zod throws BAD_REQUEST before the
    procedure body runs; same precedent as Phase 2 T01 + T6).
  - Missing MCP context → no audit (context guard runs before the
    audit envelope; same precedent as `tasks.dispatch` / T6).
- `request_id` propagated via Phase 2 lesson §4. Asserted via the
  `request_id` UUID-shape regex in the happy-path test (×3, one per
  action).

### 5. Privacy — `prompt` text NEVER echoed into audit — ✅
- Six tests (one per action × happy + mcp-error, plus the explicit
  unknown-id case) assert `payload_json` does not contain
  `"private prompt text"` / `"SECRET_PROMPT_DO_NOT_LEAK"`. The
  procedure does NOT include `prompt` in the audit payload at all —
  the lookup pulls only `id` + `name` + `agentName`, so the prompt
  text never enters the procedure-side audit envelope. Same rule
  T06's success path applies via the `hasPrompt: true` sentinel —
  except T7 does not even need a sentinel because the user is acting
  on an existing row, not submitting a new prompt.

### 6. No optimistic UI on the server — ✅
- The procedure returns `{ ok: true }` only after the daemon reply
  resolves; idempotent retries from the client are safe. The
  *client* layer applies `runOptimistic` to pause/resume only
  (UX choice), but the server contract is unchanged.

### 7. DangerConfirm wrap — ✅ (delete only)
- Delete is wrapped in `<DangerConfirm verb="Delete" subject="schedule
  <name>" expectedConfirmation={name}>` from Phase 2 T11; the
  schedule name is the typed token (T7 acceptance).
- Pause / resume are reversible — Phase 3 INDEX explicitly carves
  these out from DangerConfirm. The view-test `flips icon glyph
  between active (⏸) and paused (▶) states` pins the visible
  affordance.

## Cross-cuts I checked specifically

### a. `name_or_id: String(id)` — daemon path is unambiguous

The daemon's `bridge_schedule_{pause,resume,remove}` tools accept a
single `name_or_id` string (per `claude-bridge/src/mcp/tools.ts:300-340`).
Passing a number would coerce on the daemon side via `String(args[…])`
in `convertToCli` — fine in the happy path but ambiguous when the
schedule has a numeric-looking name. We always pass `String(id)` so
the daemon's `name OR id` resolver hits the id branch every time.
The happy-path test pins this with
`expect(calls[0]!.params).toEqual({ name_or_id: String(id) })`.

### b. Lookup-before-MCP — three motivations

1. Clean `NOT_FOUND` for ids that don't exist (refresh-stale row,
   manual URL entry) without a daemon round-trip — matches the
   `lookupLoop` precedent in `loops.cancel`.
2. Forensic audit columns: every audit row carries `name` +
   `agentName` even on the error path so the `/audit` viewer can
   render "schedule.pause schedule#42 — alpha/nightly-tests" without
   joining back to the (potentially-deleted-after-the-fact)
   schedules table. Phase 2 T04 audit-payload precedent.
3. Symmetric error shape: the unknown-id branch records
   `{ id, code: "NOT_FOUND" }` (no name/agentName — they don't
   exist) while the mcp-error branch records `{ id, name, agentName,
   code }`. Both are on the same `schedule.<action>.error` action
   string so `/audit` can filter by action prefix.

### c. The factory pattern (`makeScheduleActionProcedure`)

Three procedures with identical wire + audit + error shape are a
classic factory candidate. Inlining them as three near-duplicate
copies would:
- triple the diff (≈90 lines × 3 ≈ 270 lines vs the actual ~110
  lines + 3 one-liner bindings),
- triple the surface for drift (a future audit-payload extension
  would need three edits),
- not buy any per-action specialisation — the only differences are
  the action name (`pause`/`resume`/`remove`) and the daemon tool
  name, both of which key off `SCHEDULE_TOOL_BY_ACTION[action]`.

The factory takes the action as a parameter, returns a
`publicProcedure` instance, and the router binds `pause:
makeScheduleActionProcedure("pause")` × 3. Phase 2 lesson §1 ("risk
isolation comes from sequencing") agrees with the factor — when a
fourth schedule mutation lands (run-once-on-demand?), it inherits
the audit/lookup/error scaffolding for free.

### d. TDZ when defining the helper

Initially placed `makeScheduleActionProcedure` *below*
`schedulesRouter`. The router-literal evaluates eagerly so each
`pause: makeScheduleActionProcedure("pause")` binding tries to call
the function before its const binding is initialised — `bun test`
crashes with `Cannot access … before initialization`. Moved the
helper above the router definition; same hoisting rule we follow
for `lookupLoop` in `loops.ts`. Worth flagging because the
"helpers go after the router" pattern has been historically common
in the file and would have re-introduced the bug. The comment block
above the helper documents this for the next maintainer.

### e. Optimistic-UI scope split — pause/resume vs delete

Phase 3 INDEX §"Optimistic UI scope decision" is explicit: apply
optimistic ONLY to T7 pause/resume. The implementation honours that:

- `togglePause` runs through `runOptimistic({ apply: setEnabled(next),
  rollback: setEnabled(!next), fetcher: sendAction(...) })` —
  `apply` flips the local `enabled` state synchronously;
  `rollback` undoes it on rejection. The server-side success path
  also calls `refresh()` so the next render reflects the daemon's
  authoritative state (the daemon owns `nextRunAt`, `runCount` etc.,
  not just `enabled`).
- `deleteSubmit` is server-confirmed: no optimistic flip. The
  `<DangerConfirm>` wrapper transitions to its `success` state only
  after the network resolves; `onSuccess` (= `refresh`) drops the
  row from the next render.

The asymmetry mirrors the Phase 2 T03 pattern (`<KillTaskButton>`
uses optimistic + danger; cancel-loop in T4 uses danger without
optimistic; T7 pause/resume uses optimistic without danger — the
combinations are deliberate).

### f. Router refresh — try/catch around `useRouter`

`tests/app/schedules-page.test.ts` renders the page server-component
via `renderToStaticMarkup`, which has no `AppRouterContext`. A naive
`useRouter()` inside `<ScheduleRowActions>` would crash with
`invariant expected app router to be mounted`. Same gotcha
`<LoopControls>` hit in P3-T4; same fix here:
`useSafeRouterRefresh()` wraps `useRouter()` in try/catch and
degrades to `window.location.reload()` for the SSR path. In any
real Next.js render the catch is dead code.

### g. View vs wrapper split

Mirrors the Phase 2 T11 / P3-T4 component shape:
`ScheduleRowActionsView` is pure props-driven markup; the wrapper
`ScheduleRowActions` owns local state, reads `document.cookie`, and
drives the two fetches. This makes the view fully testable via
`renderToStaticMarkup` (no DOM, no jsdom) — pinned by 11 view tests
across the state matrix.

The wrapper itself does not have unit tests — the same precedent
the `<KillTaskButton>` / `<LoopCancelButton>` follow. Wrapper
behaviour is exercised end-to-end by the Playwright
`schedule-pause-delete.spec.ts` spec (Phase 3 step 11).

### h. Why the action error renders inline (not a toast)

The schedule list is the user's primary anchor; navigating away
from it (toast notification, top-of-page banner) would lose the
visual context that "this row failed to pause". Rendering the error
envelope inline next to the action buttons keeps the cause + the
remediation visible in one viewport. The error span uses
`role="status" aria-live="polite"` so screen readers announce the
failure without stealing focus.

### i. Action button data-testids

Used three distinct testids for Playwright targeting:
- `schedule-pause-trigger` — visible only when `enabled=true`.
- `schedule-resume-trigger` — visible only when `enabled=false`.
- `schedule-delete-trigger` — always visible.

The pause/resume split (vs a single `schedule-toggle-trigger`)
makes Playwright assertions self-documenting — `await
page.getByTestId('schedule-pause-trigger').click()` is more
intent-clear than `await
page.getByTestId('schedule-toggle-trigger').click()` followed by a
state read. Bundle cost is zero — the same `<Button>` instance
under both names.

## Test surface

| Suite | Cases | Coverage |
|---|---|---|
| `tests/server/schedules-router.test.ts` (extended) | +28 | Per-action × happy (3) + non-positive id (3) + non-integer id (3) + unknown id NOT_FOUND (3) + MCP error matrix 4 codes × 3 actions = 12 + MCP context missing (3) + unauth user_id omit (1). Each happy path pins MCP method name, `name_or_id` param, audit shape, request_id UUID. **Privacy invariant pinned on success + every error branch.** |
| `tests/lib/schedule-action-client.test.ts` | 10 | Per-action URL + body shape (3 cases via parametrised loop) + URL-table coverage assertion + `parseTrpcResponse` surface (success un-transformed + json-wrapped + NOT_FOUND error envelope + missing-code fallback + null + missing result/error). |
| `tests/app/schedule-row-actions.test.ts` | 11 | enabled=true → Pause+Delete; enabled=false → Resume+Delete; icon glyph swap (⏸ ↔ ▶); submitting disables both; csrfMissing disables both; error envelope render + absence; aria-label exposes name; title attrs; data-state reflects enabled. |

**49 new test cases total.**

`bun run test` (canonical): **866 pass / 0 fail / 4308 expect calls**.
(Was 817 pass / 4052 expect calls before T7 — delta matches the 49
new cases.)

`bun run typecheck`: clean (`tsc --noEmit` zero output).

`bun run build`: clean. `/schedules` route grew from 40.9 kB →
**41.2 kB First Load JS** — the 0.3 kB delta is the
`<ScheduleRowActions>` client island plus the new
`schedule-action-client.ts` bundle. No new runtime libs (the
optimistic helper + DangerConfirm + dispatch-client were already on
the schedules page from T6).

## Lessons / call-outs for next iters

1. **The lookup-before-MCP pattern is the right shape for every
   destructive schedule mutation.** T8 (run-history drawer) is
   read-only so it doesn't need this; if a future T-N adds e.g.
   "edit schedule" it should reuse `lookupSchedule(id)` (or
   factor it into a shared `src/server/routers/_helpers.ts` if a
   third caller appears — premature consolidation per Phase 2
   lesson §1 if there's only one caller).

2. **`makeScheduleActionProcedure` is the first factory in the
   schedule router.** If T8 introduces a similar grouping (e.g.
   `runs.list` / `runs.cancel`), prefer two distinct procedures
   over a factory unless the wire shape is genuinely identical.
   Factories are right for *symmetric* mutations; they're a
   readability trap for *similar-but-different* ones.

3. **Optimistic + DangerConfirm are independent dimensions.** The
   four-cell matrix is now used:
   - Optimistic + DangerConfirm: `<KillTaskButton>` (Phase 2 T03/T11).
   - Optimistic, no DangerConfirm: `<ScheduleRowActions>` pause/resume.
   - DangerConfirm, no optimistic: `<LoopCancelButton>` (P3-T4),
     `<ScheduleRowActions>` delete.
   - Neither: `<DispatchDialog>` (creation), `<ScheduleCreateDialog>`
     (creation), `<LoopApprovalGate>` (server-confirmed gate).
   When a future mutation lands, pick the cell consciously rather
   than copying the closest-looking component.

4. **Inline error rendering scales to ~5 schedules — the PRD
   target.** If the table grows past that, surfacing 3+
   simultaneous in-flight error envelopes inline becomes noisy. A
   page-level toast tray (filed against Phase 4 if needed) would be
   the right fix — the per-row inline message would shrink to a
   small "⚠" glyph linking to the toast.

## Verdict

✅ Ready to commit as `feat(phase-3): T07 schedule pause/resume/delete actions`.
