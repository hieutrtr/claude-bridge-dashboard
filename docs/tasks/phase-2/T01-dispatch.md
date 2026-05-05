# P2-T01 — `tasks.dispatch` via MCP

> First mutation in Phase 2. Exercises the full guarded-mutation stack
> built in slots 2–5: T12 (MCP pool transport), T08 (CSRF entry guard),
> T07 (rate-limit entry guard), T04 (audit log writer). Per the phase
> invariant, **every** mutation procedure from now on must look like
> this — call into the MCP pool, write an audit row, never duplicate
> daemon business logic.

## References

- v2 IMPLEMENTATION-PLAN P2-T1 — *"tRPC procedure mở MCP client connect
  tới daemon (endpoint trong config), gọi tool `bridge_dispatch({ agent,
  prompt })`. Timeout, retry, error mapping. Acceptance: dispatch
  round-trip < 1s; lỗi MCP stdio surface thành toast với message rõ."*
- v1 ARCH §4.2 — `tasks.dispatch({ agentName, prompt, model? })` returns
  `{ taskId }`.
- v2 ARCH §7.3 — *"v2 chọn (2) cho mutations"* — mutations route through
  the daemon's MCP tool surface, not direct DB inserts.
- v1 ARCH §10 — "every mutation writes one `audit_log` row". §3 lists
  the columns; T04 ships the writer (`appendAudit`).
- INDEX (this phase) §"Phase 2 invariant" bullets 1–5 — the contract
  this task satisfies for the first time.
- `docs/PHASE-2-REVIEW.md` §c risk table — T01 = **High**: transport
  rewrite, framing/escape risk on multi-line prompts, race when two
  dashboard processes spawn stdio.
- T12 (`src/server/mcp/pool.ts`) — pool exposes `call(method, params,
  { signal, timeoutMs })`. Errors are typed `McpPoolError` with
  `.code ∈ { MCP_TIMEOUT | MCP_BACKPRESSURE | MCP_CONNECTION_LOST |
  MCP_CONNECTION_CLOSED | MCP_ABORTED | MCP_SPAWN_FAILED |
  MCP_RPC_ERROR }`.

## Scope

- New tRPC mutation `tasks.dispatch({ agentName, prompt, model? })` on
  the existing `tasksRouter` (joins `list*` / `get` / `transcript`).
- Returns `{ taskId: number }`. The numeric `task_id` is what the
  daemon's `bridge_dispatch` MCP tool returns (matches the SQLite
  `tasks.id` autoincrement).
- Calls `mcp.call("bridge_dispatch", { agent, prompt, model? })`.
  *No* `child_process.spawn("bridge", …)` — the only transport is the
  T12 pool.
- Audits both success (`task.dispatch`) and failure
  (`task.dispatch.error` with payload `{ code }`) — failures matter for
  the audit viewer just as much as successes do.
- Maps `McpPoolError.code` → `TRPCError.code` so the client can render
  a discriminated toast (timeout vs backpressure vs daemon-down).

## Non-goals

- The dispatch dialog UI (⌘K) — that's T02; T01 only ships the server
  procedure.
- Streaming dispatch progress / log lines — handled by the existing
  Phase 1 SSE endpoint + future T09 permission relay.
- Cost-estimate pre-flight — the v2 plan defers this to T02 placeholder.
- Daemon-side `bridge_dispatch` tool implementation — that lives in
  `claude-bridge` and already exists per the bot's CLAUDE.md.
- Multi-replica / leader-election dispatch ordering — Phase 4 concern.

## Acceptance criteria

1. **Procedure shape.** `tasks.dispatch` is a tRPC `mutation` (POST
   only, runs through `csrfGuard` + `rateLimitMutations` at the route
   handler — no per-procedure middleware needed; the entry guards
   already cover all mutations on the `/api/trpc` surface).
2. **Input validation.** Zod schema requires `agentName` (1–128 chars,
   matches the daemon's name regex), `prompt` (1–32_000 chars — well
   above any human prompt and below stdio framing concerns), optional
   `model` (string, 1–64 chars). Empty / overlong → `BAD_REQUEST`.
3. **MCP call shape.** Calls `pool.call("bridge_dispatch", { agent,
   prompt, model? }, { timeoutMs: 15_000, signal })`. The signal comes
   from the request — when the HTTP request aborts, the call aborts
   too.
4. **Result extraction.** Daemon response has shape `{ task_id: number }`
   (per CLAUDE.md MCP tool contract). Procedure normalises to
   `{ taskId: number }`. Unexpected shape → `INTERNAL_SERVER_ERROR`
   with message *"daemon returned malformed dispatch response"*.
5. **Error mapping.**
   | `McpPoolError.code`        | tRPC code                | Client UX |
   |----------------------------|--------------------------|-----------|
   | `MCP_TIMEOUT`              | `TIMEOUT`                | "Daemon did not respond within 15s — retry?" |
   | `MCP_BACKPRESSURE`         | `TOO_MANY_REQUESTS`      | "Dashboard is queueing too many requests — wait a moment." |
   | `MCP_CONNECTION_LOST`      | `INTERNAL_SERVER_ERROR`  | "Connection to daemon lost — retry." |
   | `MCP_CONNECTION_CLOSED`    | `INTERNAL_SERVER_ERROR`  | (same) |
   | `MCP_SPAWN_FAILED`         | `INTERNAL_SERVER_ERROR`  | "Could not start daemon MCP — check `bridge mcp` is installed." |
   | `MCP_ABORTED`              | `CLIENT_CLOSED_REQUEST`  | (no toast — user navigated away) |
   | `MCP_RPC_ERROR`            | `INTERNAL_SERVER_ERROR`  | (forward daemon's message) |
   The mapping function is exported for reuse by T03 / T06.
6. **Audit on success.** Exactly one row appended:
   `{ action: "task.dispatch", resourceType: "task",
      resourceId: String(taskId), userId: ctx.userId,
      payload: { agentName, model }, req: ctx.req }`.
7. **Audit on failure.** Exactly one row appended:
   `{ action: "task.dispatch.error", resourceType: "task",
      resourceId: null, userId: ctx.userId,
      payload: { agentName, model, code }, req: ctx.req }`.
   `code` is the `McpPoolError.code` (or `"unexpected"` for non-pool
   errors). The audit row goes in **before** the procedure throws so
   that failures are observable even when the client never sees the
   response (e.g. abort).
8. **Prompt is not redacted.** Prompts may contain operational
   secrets, but the audit log is owner-only (T05). For correctness
   review the prompt is *not* persisted in `payload_json` — only
   `agentName` + `model`. The full prompt lives on `tasks.prompt` in
   the daemon DB; the audit row is a minimal index, not a duplicate.
9. **Multi-line prompts.** Prompts containing `\n`, embedded JSON,
   ANSI colour codes, and high-bit unicode round-trip through the
   pool's `JSON.stringify(...) + "\n"` framing without corruption.
   Test asserts byte-identical round-trip.
10. **Performance.** Round-trip on a stub server should clear well
    under the 15s timeout — no specific latency assertion (T12
    already covers p95 < 500 ms on 100 parallel; T01 piggy-backs).
11. **No singleton pollution.** The procedure resolves the MCP client
    via tRPC context (`ctx.mcp`), not by directly calling
    `getMcpPool()`. Tests inject a fake; production wires
    `getMcpPool()` once in `createContext`.

## TDD plan (RED → GREEN)

File: `tests/server/dispatch-router.test.ts` (new)

Setup mirrors `audit-integrations.test.ts`:
- tmp file DB; `runMigrations(db)`; `__setAuditDb(db)`.
- `__resetAudit()` between tests so the one-time-warn flags don't
  leak.
- Seed `agents` row so the dispatcher has something to address (the
  daemon side resolves the name, but the dashboard doesn't pre-check
  — the test only confirms the call shape).

Helper:
```ts
function fakePool(handler: (method: string, params: unknown) => Promise<unknown>) {
  return { call: handler };
}
```

Tests:

1. **Happy path.** `mcp.call` resolves with `{ task_id: 42 }`.
   Procedure returns `{ taskId: 42 }`. Exactly one audit row with
   `action="task.dispatch"`, `resource_id="42"`, `payload_json`
   containing `{"agentName":"alpha","model":"sonnet"}`.
2. **Call shape.** `mcp.call` is invoked with method
   `"bridge_dispatch"` and params `{ agent: "alpha", prompt: "do it",
   model: "sonnet" }`. Optional `model` omitted from params when not
   provided.
3. **Multi-line prompt round-trip.** Prompt `"line1\nline2\n  with\ttabs\nemoji 🎉\n"`
   passes through unchanged; the fake records exactly the same string.
4. **Input validation — empty prompt** → tRPC `BAD_REQUEST`. No
   audit row. No MCP call.
5. **Input validation — empty agent** → tRPC `BAD_REQUEST`.
6. **Input validation — prompt > 32_000 chars** → tRPC `BAD_REQUEST`.
7. **Result shape error** — `mcp.call` returns `{ ok: true }` (no
   `task_id`). tRPC `INTERNAL_SERVER_ERROR`; audit row with
   `action="task.dispatch.error"`, payload code `"malformed_response"`.
8. **MCP_TIMEOUT** → tRPC `TIMEOUT`; audit row with code
   `"MCP_TIMEOUT"`.
9. **MCP_BACKPRESSURE** → tRPC `TOO_MANY_REQUESTS`; audit row with
   code `"MCP_BACKPRESSURE"`.
10. **MCP_CONNECTION_LOST** → tRPC `INTERNAL_SERVER_ERROR`; audit row.
11. **MCP_SPAWN_FAILED** → tRPC `INTERNAL_SERVER_ERROR`; audit row.
12. **MCP_RPC_ERROR** → tRPC `INTERNAL_SERVER_ERROR`; the daemon's
    error message is preserved in the tRPC error message.
13. **MCP_ABORTED** → tRPC `CLIENT_CLOSED_REQUEST`; audit row with
    code `"MCP_ABORTED"`.
14. **`ctx.req` propagates to audit.** When the caller passes a
    `Request` with `x-forwarded-for: 5.6.7.8` and `JWT_SECRET` set,
    `ip_hash` on the audit row is non-null.
15. **`ctx.userId` propagates.** When `userId="owner"`, the audit
    row's `user_id` is `"owner"`. When `userId=null`, it's `null`.

## Implementation outline

### `src/server/mcp/pool.ts` (extend)

Export a minimal client interface so tests don't have to construct a
real `McpPool`:

```ts
export interface McpClient {
  call(method: string, params: unknown, opts?: CallOptions): Promise<unknown>;
}
```

`McpPool` already implements this. `getMcpPool(): McpClient` (return
type widened from `McpPool` to `McpClient`).

### `src/server/trpc.ts` (replace context)

```ts
export interface Context {
  /** Original Request — used by audit for ip_hash + UA derivation. */
  req?: Request;
  /** Resolved JWT subject, or null when unauthenticated. */
  userId?: string | null;
  /** MCP transport client. Required for mutation procedures. */
  mcp?: McpClient;
}
```

Mutation procedures consume `ctx.mcp`; queries can ignore it.

### `app/api/trpc/[trpc]/route.ts` (extend `createContext`)

```ts
createContext: () => ({
  req,
  userId: sessionUserId,
  mcp: getMcpPool(),
})
```

### `src/server/routers/tasks.ts` (add dispatch)

```ts
const DispatchInput = z.object({
  agentName: z.string().min(1).max(128),
  prompt: z.string().min(1).max(32_000),
  model: z.string().min(1).max(64).optional(),
});

dispatch: publicProcedure
  .input(DispatchInput)
  .mutation(async ({ input, ctx }) => {
    const params: { agent: string; prompt: string; model?: string } = {
      agent: input.agentName,
      prompt: input.prompt,
    };
    if (input.model !== undefined) params.model = input.model;

    const auditBase = {
      resourceType: "task" as const,
      userId: ctx.userId ?? null,
      req: ctx.req,
    };

    let result: unknown;
    try {
      result = await ctx.mcp!.call("bridge_dispatch", params, { timeoutMs: 15_000 });
    } catch (err) {
      const code = err instanceof McpPoolError ? err.code : "unexpected";
      appendAudit({
        ...auditBase,
        action: "task.dispatch.error",
        resourceId: null,
        payload: { agentName: input.agentName, model: input.model, code },
      });
      throw mapMcpErrorToTrpc(err);
    }

    const taskId = extractTaskId(result);
    if (taskId === null) {
      appendAudit({
        ...auditBase,
        action: "task.dispatch.error",
        resourceId: null,
        payload: { agentName: input.agentName, model: input.model, code: "malformed_response" },
      });
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "daemon returned malformed dispatch response",
      });
    }

    appendAudit({
      ...auditBase,
      action: "task.dispatch",
      resourceId: String(taskId),
      payload: { agentName: input.agentName, model: input.model },
    });

    return { taskId };
  }),
```

### `src/server/mcp/errors.ts` (new)

`mapMcpErrorToTrpc(err)` switch over `McpPoolError.code` per the table
above. Also exports for T03 / T06 to reuse.

## Risk + mitigation

| Risk (PHASE-2-REVIEW §c.T01) | Mitigation |
|------------------------------|------------|
| Stdio framing corruption on multi-line / unicode prompts | Test 3 round-trips a deliberately gnarly string; the pool already JSON-stringifies which is utf-8-safe; no additional escape needed. |
| Two dashboard processes spawning concurrent stdio children | Out of scope (single-process pool — INDEX "Notes"). T01 inherits T12's single-process guarantee. |
| Daemon `bridge mcp` does not exist yet | T12 already flags this; T01 uses fake-pool injection in tests, so T01 itself is testable end-to-end without daemon. Production wiring fails fast with `MCP_SPAWN_FAILED` → audited + toast. |
| Audit-write-after-throw race | We audit *before* throw (try/catch order in implementation outline) — failures observable even on early abort. |
| Prompt secrets leaking into audit | Audit `payload_json` deliberately excludes `prompt`; only metadata (`agentName`, `model`) is recorded. |
| Race between dispatch and audit | bun:sqlite is sync — audit insert is serialised on the same DB handle; no race window. |
| `mcp.call` hangs forever if pool seam mis-injected | 15s timeout enforced inside the pool. Tests assert MCP_TIMEOUT path. |
