# P3-T3 — `loops.start` mutation + Start-loop dialog

> First Phase 3 mutation. Replaces the CLI-only `bridge loop start
> <agent> <goal> --done-when ...` invocation with a /loops dashboard
> dialog backed by a new `loops.start` tRPC mutation that calls the
> daemon's `bridge_loop` MCP tool through the Phase 2 pool.

## Scope

- **Router** — extend `src/server/routers/loops.ts` with one new
  mutation procedure, `start({ agentName, goal, doneWhen,
  maxIterations?, maxCostUsd?, loopType?, planFirst?, passThreshold?,
  channelChatId? })`. Calls daemon MCP `bridge_loop` (15s timeout —
  same as approve/reject in T06). Returns `{ loopId }`.
- **DTO** — add `LoopStartResult` to `src/server/dto.ts`. Single field
  `loopId: string`. Mirrors `DispatchResult` from Phase 2 T01.
- **Privacy** — `goal` text forwarded to daemon but **NEVER** echoed
  into `audit_log.payload_json`. Audit records `hasGoal: true`
  sentinel only. Same rule as `tasks.dispatch.prompt` and
  `loops.reject.reason`.
- **Browser helpers** — `src/lib/loop-start-client.ts`. Pure (no DOM)
  helpers: request builder, tRPC envelope unwrapper, doneWhen
  composition + validation, and the `LoopStartError` type. Test
  surface stays a plain `bun test` (no jsdom).
- **Dialog** — `src/components/start-loop-dialog.tsx`. Two named
  exports: `StartLoopDialogView` (pure markup; tested via
  `renderToStaticMarkup`) and `StartLoopDialog` (interactive wrapper).
  Plus `StartLoopTrigger` button mirroring Phase 2's
  `<DispatchTrigger>`. Open-state authority via the
  `bridge:open-start-loop` custom event.
- **Page** — `app/loops/page.tsx` adds the trigger to the page header
  and mounts the dialog. Submit redirects via the success-state link
  to `/loops/[loopId]`.

## Wire shape

```ts
loops.start({
  agentName:      string,    // 1..128, must match an existing agent
  goal:           string,    // 1..32_000, forwarded verbatim
  doneWhen:       string,    // 1..2_000, /^(command|file_exists|file_contains|llm_judge|manual):.*$/
  maxIterations?: int,       // 1..200
  maxCostUsd?:    number,    // 0..10_000 (positive)
  loopType?:      "bridge" | "agent" | "auto",
  planFirst?:     boolean,
  passThreshold?: int,       // 1..10
  channelChatId?: string,    // 1..128, opaque
}) → { loopId: string }
```

Daemon MCP params (snake_case, transformed in-procedure):

```ts
bridge_loop({
  agent: agentName,
  goal,
  done_when: doneWhen,
  max_iterations?: int,
  max_cost_usd?: number,
  loop_type?: string,
  plan_first?: boolean,
  pass_threshold?: int,
  chat_id?: string,
  user_id?: string,   // resolved server-side from JWT subject
}) → MCP `text("Started loop <loop_id>")` envelope OR `{ loop_id }` (test fake)
```

The procedure's `extractLoopId` parses both shapes:
1. `value.loop_id: string` → use directly (matches the test-side fake).
2. Otherwise scan `value.content[].text` for `/Started loop (\S+)/` —
   the daemon's actual on-wire shape per
   `src/mcp/tool-handlers.ts::executeToolNative` (`text(`Started loop
   ${loopId}`)`).

Falling through both → audit `malformed_response` + throw
`INTERNAL_SERVER_ERROR`.

## Acceptance

1. `loops.start` over a fake MCP returning `{ content: [{ type:
   "text", text: "Started loop loop-abc123" }] }` returns
   `{ loopId: "loop-abc123" }`.
2. The same procedure also accepts the test-side `{ loop_id: "..." }`
   shape — the existing in-process audit + dispatch tests use this
   contract; the daemon's actual envelope is the production path.
3. Goal text is forwarded to the daemon but NEVER appears in
   `audit_log.payload_json`. Both success and error paths assert this
   via a SECRET-substring test.
4. Audit success row records: `agentName, doneWhen, hasGoal=true`,
   plus every optional metadata field that was actually supplied
   (`maxIterations`, `maxCostUsd`, `loopType`, `planFirst`,
   `passThreshold`). Absent inputs do NOT populate the payload.
5. `channelChatId` is forwarded as the daemon's `chat_id` param but
   the audit row records only `hasChannelChatId: true` (semi-opaque).
6. `user_id` is forwarded to the daemon when `ctx.userId` is set;
   omitted otherwise.
7. Input validation rejects: empty goal, oversized goal, malformed
   `doneWhen` (no recognized prefix), out-of-range
   `maxIterations`/`maxCostUsd`/`passThreshold`. No MCP call, no
   audit row on validation failure.
8. MCP error mapping inherited from Phase 2 T01 — every
   `McpPoolError` code → audit `loop.start.error` with the
   `auditFailureCode` + `mapMcpErrorToTrpc` translation.
9. Missing MCP context (no `ctx.mcp` wired) → `INTERNAL_SERVER_ERROR`
   without an audit row.
10. Dialog form composes the server-side `doneWhen` value live (e.g.
    selecting "command" + typing `bun test` previews `command: bun
    test`). `manual` preset with empty value renders the bare
    `manual:` form (server accepts).
11. Submit disabled when: agents loading / no agents / empty goal /
    invalid doneWhen / out-of-range numerics / csrfMissing /
    submitting in flight.
12. Success state surfaces a `<Link>` to `/loops/[loopId]` (mirrors
    dispatch's `/tasks/[id]` link).
13. Error state preserves form values and re-enables submit so the
    user can retry without retyping.

## Phase 3 invariant checklist (per INDEX §invariant)

- [x] **Calls MCP** — `ctx.mcp.call("bridge_loop", ...)` via the T12
      pool. No CLI spawn, no direct table mutation.
- [x] **CSRF guard** — POST → `csrfGuard` runs in
      `app/api/trpc/[trpc]/route.ts` before the procedure. The
      browser dialog sends the `x-csrf-token` header read from the
      `bridge_csrf_token` cookie via
      `readCsrfTokenFromCookie(document.cookie)`. CSRF-missing UX
      surfaces "session expired — reload the page".
- [x] **Rate limit** — same 30-mutations/min/user bucket as Phase 2
      via `rateLimitMutations` middleware. No separate quota.
- [x] **Audit log** — `appendAudit({ ctx, action: "loop.start",
      resourceId: loopId, payload })` runs BEFORE the procedure
      returns. `request_id` propagated via Phase 2 lesson §4.
- [x] **No optimistic UI** — start mutation produces a server-side
      `loop_id` we don't predict client-side (per INDEX §"Optimistic
      UI scope decision").
- [x] **No DangerConfirm** — creation is not destructive (per INDEX
      Phase 3 invariant note). DangerConfirm lands in T4 (cancel) and
      T7 (delete schedule).

## Tests

| File | Coverage |
|---|---|
| `tests/server/loops-router.test.ts` (extended) | 19 new cases — happy path (text envelope + structured fake), MCP params shape, audit privacy (goal absent), input validation across every field, malformed daemon response (no `loop_id` and no "Started loop X" text), every `McpPoolError` code mapping, missing MCP context |
| `tests/lib/loop-start-client.test.ts` | 12 cases — `composeDoneWhen` for every prefix incl. manual edge case, `isValidDoneWhen` boundary checks, `buildLoopStartRequest` envelope, `parseTrpcResponse` for both un-transformed + json-wrapped envelopes |
| `tests/app/loop-start-dialog.test.ts` | 16 cases — open/close, loading state, full form on idle, manual + non-manual `doneWhen` validation, submit-disabled matrix (loading / submitting / no agents / empty goal / invalid numerics / csrfMissing), success Loop link, error preservation, agents-empty hint, dialog never echoes goal into data-/aria- attribute |

47 new test cases total. All exercise `appRouter.createCaller`
against a tmp on-disk SQLite DB (mirrors Phase 2 T01 dispatch test
shape) where applicable; component tests render via
`react-dom/server`'s `renderToStaticMarkup` per Phase 2 T02
precedent.

## Implementation notes

- **Daemon response parsing**: pre-existing `tasks.dispatch` test uses
  a mocked `{ task_id: 42 }` shape that does not match the daemon's
  actual `text("Task #N dispatched...")` envelope. We do not fix that
  here (out of scope for T3). For `loops.start` we accept BOTH the
  structured-fake shape AND the actual daemon text envelope — the
  test-side fake stays cheap, while production calls hit the
  `/Started loop (\S+)/` regex branch.
- **`done_when` regex** is single-sourced in two places: the Zod
  refinement on the server (`DONE_WHEN_PATTERN` in
  `src/server/routers/loops.ts`) and the same pattern in
  `src/lib/loop-start-client.ts` for client-side UX. Drift would mean
  the server rejects what the client thinks is valid; `composeDoneWhen`
  + `isValidDoneWhen` both unit-tested.
- **Optional input fields**: Zod's `.optional()` rejects an explicit
  `undefined` as structurally present; the dialog never includes a
  key in the JSON envelope unless the user supplied a value. Same
  pattern as `tasks.dispatch.model` from Phase 2 T01.
- **Iter SSE feed for new loop**: when the loop appears in the
  `loops.list` table, the user navigates to `/loops/[loopId]` (T2)
  and the detail page polls every 2s (per T2 spec). No new SSE route
  here — multiplex deferred to Phase 4 (per Phase 2 lesson §3).
- **Agent dropdown caching**: reuses
  `AGENTS_CACHE` from `src/components/dispatch-dialog.tsx` shape via
  the `__resetStartLoopAgentsCache` test hook. The two dialogs do not
  share a literal cache module — splitting now would be premature
  (the dispatch cache is still under the same "lazy load on first
  open" rule).

## Daemon-side gap notes

The daemon `bridge_loop` tool docstring lists `chat_id` and `user_id`
as accepted params but only forwards them to `LoopOrchestrator.startLoop`
when present (see `src/mcp/tool-handlers.ts:223`). `chat_id` is needed
for Telegram channel routing — kept as a dialog field but optional;
default UX path is "no Telegram routing", which means loop status
notifications surface only on the dashboard.

The daemon also accepts `--max-iterations`, `--loop-type`, and
`--max-cost` flags via the CLI mapping (`src/mcp/tools.ts:419`); we
forward all three. `--plan-first` and `--pass-threshold` flags exist
in the orchestrator but the CLI-mapping only surfaces the first three;
the in-process MCP path uses the JSON params directly so these flow
through.
