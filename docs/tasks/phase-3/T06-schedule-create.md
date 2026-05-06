# P3-T6 — `schedules.add` mutation + create dialog with cron picker

> **Loop step 7/11.** First Phase 3 mutation in the schedules
> vertical, and the only novel UI component this phase introduces.
> Replaces the CLI-only `bridge schedule add <agent> <prompt>
> --interval-minutes <N>` invocation with a `/schedules` dashboard
> dialog backed by a new `schedules.add` tRPC mutation that calls the
> daemon's `bridge_schedule_add` MCP tool through the Phase 2 pool.

## Scope

- **Router** — extend `src/server/routers/schedules.ts` with one new
  mutation procedure, `add({ name?, agentName, prompt, intervalMinutes,
  cronExpr?, channelChatId? })`. Calls daemon MCP `bridge_schedule_add`
  (15s timeout, same as `loops.start`). Returns `{ id }`.
- **DTO** — add `ScheduleAddResult` to `src/server/dto.ts`. Single
  field `id: number`. Mirrors `DispatchResult` from Phase 2 T01 +
  `LoopStartResult` from P3-T3.
- **Privacy** — `prompt` text forwarded to daemon but **NEVER** echoed
  into `audit_log.payload_json`. Audit records `hasPrompt: true`
  sentinel only. Same rule as `tasks.dispatch.prompt` and
  `loops.start.goal`.
- **Browser helpers** — `src/lib/schedule-add-client.ts`. Pure (no
  DOM) helpers: cron picker preset table, cron→interval conversion
  via `cron-parser`, request builder, tRPC envelope unwrapper, and
  the `ScheduleAddError` type. Test surface stays a plain `bun test`
  (no jsdom).
- **Cron picker** — `src/components/cron-picker.tsx`. Pure
  presentational `<CronPickerView>` plus an interactive
  `<CronPicker>` wrapper that owns mode (`preset` | `custom`),
  preset selection, and custom-mode raw input. Emits
  `{ cronExpr, intervalMinutes, valid, error?, nextFires[] }`
  through an `onChange` prop so the parent dialog stays in
  control of submit-disable state.
- **Dialog** — `src/components/schedule-create-dialog.tsx`. Two
  named exports: `ScheduleCreateDialogView` (pure markup; tested via
  `renderToStaticMarkup`) and `ScheduleCreateDialog` (interactive
  wrapper). Plus `ScheduleCreateTrigger` mirroring T03's
  `<StartLoopTrigger>`. Open-state authority via the
  `bridge:open-schedule-create` custom event.
- **Page** — `app/schedules/page.tsx` adds the trigger to the
  page header and mounts the dialog. Submit closes the dialog; the
  caller's `router.refresh()` round-trips the new schedule into the
  table within a polling tick.

## Wire shape

```ts
schedules.add({
  name?:           string,    // 1..128, optional → daemon auto-generates
  agentName:       string,    // 1..128, must match an existing agent
  prompt:          string,    // 1..32_000, forwarded verbatim
  intervalMinutes: int,       // 1..43_200 (≤ 30 days), required
  cronExpr?:       string,    // 1..256, optional metadata
  channelChatId?:  string,    // 1..128, opaque
}) → { id: number }
```

Daemon MCP params (snake_case, transformed in-procedure):

```ts
bridge_schedule_add({
  agent_name:       agentName,
  prompt,
  interval_minutes: intervalMinutes,
  name?:            string,
  chat_id?:         string,
  user_id?:         string,   // resolved server-side from JWT subject
}) → MCP `text("Schedule #<id> created")` envelope
     OR `{ id }` (test fake)
```

The procedure's `extractScheduleId` parses both shapes:
1. `value.id: number` → use directly (matches the test-side fake).
2. Otherwise scan `value.content[].text` for
   `/Schedule\s+#(\d+)\s+created/` — the daemon's actual on-wire
   shape per `src/mcp/tool-handlers.ts:344` (`text(`Schedule #${id}
   created`)`).

Falling through both → audit `malformed_response` + throw
`INTERNAL_SERVER_ERROR`.

## Cron daemon-side gap (decision)

The daemon `bridge_schedule_add` MCP tool **only** accepts
`interval_minutes` — no `cron_expr` parameter (per
`src/mcp/tools.ts:285` — `required: ["agent_name", "prompt",
"interval_minutes"]`). INDEX §"Cron daemon-side gap" anticipated
this: the dashboard converts cron → interval client-side before
submit, and the cron picker rejects expressions whose fire-time
deltas are non-uniform.

Conversion rule (in `cronToIntervalMinutes`):
1. Use `CronExpressionParser.parse(expr)` to get the next 4 fire
   times from `now`.
2. Compute the 3 consecutive deltas in milliseconds.
3. If all three deltas are equal AND the value is a positive integer
   number of minutes → return that interval.
4. Otherwise → return `null` (UI lights up red border: "this cron
   expression doesn't translate to a uniform interval — the daemon
   only supports interval-mode schedules today").

Preset table (constants in `schedule-add-client.ts`):

| Label              | cronExpr      | Interval (min) |
|--------------------|---------------|---------------:|
| Every hour         | `0 * * * *`   |             60 |
| Daily at 09:00     | `0 9 * * *`   |          1 440 |
| Weekly Mon at 09:00| `0 9 * * 1`   |         10 080 |

The cron picker forwards `cronExpr` AS METADATA on the wire (the
list view's `cronstrue` formatter renders it human-readable on
`/schedules`), but the daemon currently ignores the field — the
authoritative cadence comes from `intervalMinutes`. When the daemon
grows native cron support, the dashboard side already plumbs the
column through.

## Acceptance

1. `schedules.add` over a fake MCP returning `{ content: [{ type:
   "text", text: "Schedule #42 created" }] }` returns `{ id: 42 }`.
2. The same procedure also accepts the test-side `{ id: 42 }` shape
   so the test fixture stays cheap.
3. Prompt text is forwarded to the daemon but NEVER appears in
   `audit_log.payload_json`. Both success and error paths assert
   this via a SECRET-substring test.
4. Audit success row records: `agentName, intervalMinutes,
   hasPrompt=true`, plus `name` (when supplied),
   `cronExpr` (when supplied — short label string, not opaque),
   and `hasChannelChatId: true` (when supplied).
5. `user_id` is forwarded to the daemon when `ctx.userId` is set;
   omitted otherwise.
6. Input validation rejects: empty / oversized prompt / agentName,
   out-of-range `intervalMinutes` (≤0, > 43_200), oversized cron
   expression. No MCP call, no audit row on validation failure.
7. MCP error mapping inherited from Phase 2 T01 — every
   `McpPoolError` code → audit `schedule.add.error` with the
   `auditFailureCode` + `mapMcpErrorToTrpc` translation.
8. Missing MCP context (no `ctx.mcp` wired) → `INTERNAL_SERVER_ERROR`
   without an audit row.
9. Cron picker — preset radios fill the cron expression and
   compute interval (60 / 1 440 / 10 080).
10. Cron picker — custom-mode invalid expression renders red border
    and "Invalid cron expression" message; submit disabled.
11. Cron picker — custom-mode non-uniform interval (e.g.
    `0 9 * * 1-5` weekdays) renders yellow warning + "Daemon only
    accepts uniform intervals today"; submit disabled.
12. Cron picker — valid expression renders cronstrue label + the
    next 3 fire times computed from `now`.
13. Dialog — submit disabled when: agents loading / no agents /
    empty prompt / invalid cron / csrfMissing / submitting in
    flight.
14. Success state surfaces a "Schedule created" message + Dismiss /
    Add another buttons. Caller is expected to refresh the
    `/schedules` table.

## Phase 3 invariant checklist (per INDEX §invariant)

- [x] **Calls MCP** — `ctx.mcp.call("bridge_schedule_add", ...)`
      via the T12 pool. No CLI spawn, no direct table mutation.
- [x] **CSRF guard** — POST → `csrfGuard` runs in
      `app/api/trpc/[trpc]/route.ts` before the procedure. The
      browser dialog sends the `x-csrf-token` header read from the
      `bridge_csrf_token` cookie via
      `readCsrfTokenFromCookie(document.cookie)`. CSRF-missing UX
      surfaces "session expired — reload the page".
- [x] **Rate limit** — same 30-mutations/min/user bucket as Phase 2
      via `rateLimitMutations` middleware. No separate quota.
- [x] **Audit log** — `appendAudit({ ctx, action: "schedule.add",
      resourceId: String(id), payload })` runs BEFORE the procedure
      returns. `request_id` propagated via Phase 2 lesson §4.
- [x] **No optimistic UI** — add mutation produces a server-side
      `id` we don't predict client-side (per INDEX §"Optimistic UI
      scope decision").
- [x] **No DangerConfirm** — creation is not destructive (per INDEX
      Phase 3 invariant note). DangerConfirm lands in T7 (delete
      schedule).

## Tests

| File | Coverage |
|---|---|
| `tests/server/schedules-router.test.ts` (extended) | 17 new cases — happy path (text envelope + structured fake), MCP params shape, audit privacy (prompt absent), input validation across every field, malformed daemon response (no `id` and no "Schedule #X created" text), every `McpPoolError` code mapping, missing MCP context |
| `tests/lib/schedule-add-client.test.ts` | 13 cases — `cronToIntervalMinutes` (every preset + non-uniform reject + malformed reject), `nextFires` (deterministic with injected `now`), `buildScheduleAddRequest` envelope, `parseTrpcResponse` for both un-transformed + json-wrapped envelopes, `CRON_PRESETS` snapshot |
| `tests/app/cron-picker.test.ts` | 11 cases — preset selection fills cron field, custom mode renders raw input, invalid → red border, non-uniform → yellow warning, valid → cronstrue + next-3 preview, mode switch retains state |
| `tests/app/schedule-create-dialog.test.ts` | 9 cases — open/close, loading state, full form on idle, submit-disabled matrix (loading / submitting / no agents / empty prompt / invalid cron / csrfMissing), success state, error preservation, dialog never echoes prompt into data-/aria- attribute |

50 new test cases total. All exercise `appRouter.createCaller`
against a tmp on-disk SQLite DB (mirrors Phase 2 T01 dispatch test
shape) where applicable; component tests render via
`react-dom/server`'s `renderToStaticMarkup` per Phase 2 T02
precedent.

## Implementation notes

- **Daemon response parsing**: pre-existing `tasks.dispatch` test
  uses a mocked `{ task_id: 42 }` shape that does not match the
  daemon's actual `text("Task #N dispatched...")` envelope. We do
  not fix that here (out of scope for T6). For `schedules.add` we
  accept BOTH the structured-fake shape (`{ id }`) AND the actual
  daemon text envelope — the test-side fake stays cheap, while
  production calls hit the `/Schedule\s+#(\d+)\s+created/` regex
  branch.
- **`cronExpr` regex** is a loose 5-field validator (the cron picker
  feeds known-good presets or `cron-parser` validates user input);
  the server zod refinement only checks length + non-empty so a
  future daemon-side cron field doesn't require a server-side
  re-validation pass.
- **Optional input fields**: Zod's `.optional()` rejects an explicit
  `undefined` as structurally present; the dialog never includes a
  key in the JSON envelope unless the user supplied a value. Same
  pattern as `tasks.dispatch.model` from Phase 2 T01 +
  `loops.start.maxIterations` from P3-T3.
- **Agents dropdown reuse**: same lazy `agents.list` fetch as
  `<StartLoopDialog>` (P3-T3). We do NOT share the literal
  `AGENTS_CACHE` across the two dialogs — premature consolidation
  per Phase 2 lesson §1; if a third dialog opens we'll factor the
  cache module then.

## Daemon-side gap notes (carried into review)

`bridge_schedule_add` ignores any `cron_expr` field in the params —
the daemon's `addSchedule` call only forwards `interval_minutes`
(see `src/mcp/tool-handlers.ts:333-345`). The dashboard side
records `cronExpr` in `audit_log.payload_json` (short label, not
opaque) so the forensic trail captures the user's *intent*, but
the daemon-side `schedules` row will only have `interval_minutes`
populated. The `/schedules` page renders `cronstrue` for rows that
DO have `cron_expr` (CLI-created), and falls back to "Every N
minutes" for the rest.

When the daemon grows native cron support (filed against
`claude-bridge` — out of this loop's scope), the procedure flips
to forwarding `cron_expr` as a daemon param; no dashboard wire
change needed.
