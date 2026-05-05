# P2-T03 — `tasks.kill` via MCP

> Second mutation in Phase 2. Reuses the guarded-mutation stack stood up
> by T12 (transport), T08 (CSRF), T07 (rate-limit), T04 (audit) and the
> error-mapping helpers from T01 (`mapMcpErrorToTrpc` / `auditFailureCode`).
> Critical wrinkle vs T01: **idempotency** — the daemon `bridge_kill` MCP
> tool kills *the running task on an agent*, but the dashboard receives a
> task **id** and may race the daemon (the user clicks Kill while the task
> is finishing). The procedure converts that race into a friendly
> `{ alreadyTerminated: true }` instead of a confusing 500.

## References

- v2 IMPLEMENTATION-PLAN P2-T3 — *"`tasks.kill({ id })` tRPC mutation calling
  MCP `bridge_kill` for the task's agent. Idempotent (already-done →
  return ok with warning, not error). Kill button on `/tasks/[id]` for
  `running` tasks; status flips to `killed` in ≤ 2 s."*
- v1 ARCH §4.2 — `tasks.kill({ id })` returns `{ ok: boolean,
  alreadyTerminated: boolean }`.
- v1 ARCH §10 — every mutation writes one `audit_log` row (success and
  failure).
- INDEX (this phase) §"Phase 2 invariant" — same five rules as T01.
- `docs/PHASE-2-REVIEW.md` §c risk table — T03 = **Medium**: idempotency
  surface; killing already-done task should not error confusingly.
- T01 spec (`docs/tasks/phase-2/T01-dispatch.md`) — same call-shape /
  audit / error-mapping pattern; reuse `mapMcpErrorToTrpc` +
  `auditFailureCode`.
- CLAUDE.md (bot dir) §"bridge_kill" — MCP tool signature
  `bridge_kill({ agent: string })` (kills the running task on an agent
  *by agent name*, not by task id).

## Scope

- New tRPC mutation `tasks.kill({ id })` on the existing `tasksRouter`.
- Returns `{ ok: true, alreadyTerminated: boolean }`. `alreadyTerminated`
  is `true` when (a) the dashboard sees the task in a terminal status
  before calling MCP, or (b) the daemon reports "no running task" via
  `MCP_RPC_ERROR` (race window).
- Looks up the task → resolves agent name via the existing
  `tasks.session_id → agents.session_id` join.
- Calls `mcp.call("bridge_kill", { agent }, { timeoutMs: 15_000 })`.
  *No* `child_process.spawn` — only the T12 pool transport.
- Audits both terminal paths (`task.kill` for ok, `task.kill.error` for
  pool errors that aren't the "already terminated" race).

## Non-goals

- The kill button + confirmation dialog UI — that's T11 (confirmation
  primitive) + a UI step that lands on `/tasks/[id]`. T03 only ships the
  server procedure.
- Optimistic UI updates — that's T10 (kill is *one* of the two mutations
  T10 wires optimistic for, alongside dispatch).
- Cancel semantics for queued/pending tasks — `bridge_kill` is the
  daemon's single primitive; whether it kills a `pending` row or only a
  `running` one is the daemon's concern.
- Bulk kill / kill-all-on-agent — out of scope for the dashboard.

## Acceptance criteria

1. **Procedure shape.** `tasks.kill` is a tRPC `mutation` (POST only,
   runs through `csrfGuard` + `rateLimitMutations` at the route handler
   — same surface as `tasks.dispatch`).
2. **Input validation.** Zod schema requires `id` as a positive integer
   (matches `tasks.id` autoincrement). Negative / zero / non-integer →
   `BAD_REQUEST`.
3. **Task not found.** Unknown `id` → tRPC `NOT_FOUND` with message
   *"task not found"*. **No** audit row (we don't log probes against
   non-existent ids — same pattern as `tasks.get` which returns `null`
   instead of throwing for queries).
4. **Already terminated (server-side check).** When the lookup row's
   `status` is one of `done | failed | killed`, the procedure returns
   `{ ok: true, alreadyTerminated: true }` **without calling MCP**. One
   audit row appended:
   `{ action: "task.kill", resource_id: String(id),
      payload: { agentName, status, alreadyTerminated: true } }`.
5. **Active kill — happy path.** When status is `pending | queued |
   running` (or any non-terminal value), the procedure calls
   `bridge_kill({ agent: agentName })`. On success returns
   `{ ok: true, alreadyTerminated: false }`. One audit row:
   `{ action: "task.kill", resource_id: String(id),
      payload: { agentName, status, alreadyTerminated: false } }`.
6. **Race — daemon says "not running".** When the daemon throws
   `McpPoolError("MCP_RPC_ERROR", message)` and the message matches
   `/no.*running|not.*running|already.*(done|terminated|killed|finished)/i`,
   the procedure **swallows the error** and returns
   `{ ok: true, alreadyTerminated: true }`. One audit row:
   `{ action: "task.kill", resource_id: String(id),
      payload: { agentName, status, alreadyTerminated: true,
                 raceDetected: true } }`. Other RPC error messages
   propagate normally.
7. **Pool errors map per T01.** Reuse `mapMcpErrorToTrpc` +
   `auditFailureCode` for `MCP_TIMEOUT`, `MCP_BACKPRESSURE`,
   `MCP_CONNECTION_LOST`, `MCP_SPAWN_FAILED`, `MCP_ABORTED`, generic
   `MCP_RPC_ERROR`. On error, audit row is
   `{ action: "task.kill.error", resource_id: String(id),
      payload: { agentName, code } }` written **before** the throw.
8. **Idempotency on repeated call.** Calling `tasks.kill({ id })` twice
   in a row, where the first call succeeded, is well-defined: the
   second call hits the "already terminated" path (after the daemon has
   updated `tasks.status = killed`) and returns
   `{ ok: true, alreadyTerminated: true }`. No throw, no error toast.
9. **Audit correlation.** Each call appends exactly one row (success
   path — no double-write because the success and failure branches are
   mutually exclusive). Success rows correlate to the task via
   `resource_id`; the audit viewer (T05) can render a "killed by user
   X at time Y" trail per task.
10. **No daemon side-effect on dashboard-side terminal check.** The
    "already terminated" early-return path in criterion 4 does **not**
    call MCP — verified by test counting `mcp.calls.length === 0`. This
    avoids spamming the daemon with no-op kills when an old browser tab
    re-renders a stale row.
11. **`ctx.req` propagates to audit.** Same as T01 — when
    `x-forwarded-for` and `JWT_SECRET` are set, `ip_hash` on the audit
    row is non-null.
12. **`ctx.userId` propagates.** Same as T01.

## TDD plan (RED → GREEN)

File: `tests/server/kill-router.test.ts` (new)

Setup mirrors `dispatch-router.test.ts` (tmp DB, `runMigrations`,
`__setAuditDb`, `fakePool` helper). The new bit: seed the `agents` +
`tasks` tables so the lookup join in the procedure has rows to find.

```ts
function seedTaskRow(db: Database, opts: {
  id: number; agentName: string; sessionId: string; status: string;
}) {
  // INSERT into agents (name, project_dir, session_id, agent_file)
  //   ON CONFLICT(name, project_dir) DO NOTHING
  // INSERT into tasks (id, session_id, prompt, status)
}
```

Tests:

1. **Happy path — running task.** Seed `(id=1, agent="alpha",
   status="running")`. `mcp.call` resolves with `{ ok: true }`.
   Procedure returns `{ ok: true, alreadyTerminated: false }`. MCP
   call shape: method `"bridge_kill"`, params `{ agent: "alpha" }`,
   timeoutMs 15_000. One audit row, `action="task.kill"`,
   `resource_id="1"`, payload `{ agentName: "alpha", status: "running",
   alreadyTerminated: false }`.
2. **Happy path — pending task.** Seed `status="pending"`. Same shape;
   payload status is `"pending"`.
3. **Happy path — queued task.** Same with `status="queued"`.
4. **Already terminated — done.** Seed `status="done"`. Procedure
   returns `{ ok: true, alreadyTerminated: true }` **without calling
   MCP** (`calls.length === 0`). Audit payload includes
   `alreadyTerminated: true`.
5. **Already terminated — failed.** Seed `status="failed"`. Same shape.
6. **Already terminated — killed.** Seed `status="killed"`. Same shape.
7. **Race — daemon "no running task".** Seed `status="running"`.
   `mcp.call` throws `McpPoolError("MCP_RPC_ERROR", "no running task
   on agent alpha")`. Procedure swallows → returns
   `{ ok: true, alreadyTerminated: true }`. Audit payload includes
   `alreadyTerminated: true, raceDetected: true`.
8. **Race — "already terminated".** Same with daemon message
   `"task already terminated"` (case-insensitive regex match).
9. **Race — "already finished".** Same with `"already finished"`.
10. **Generic RPC error.** `MCP_RPC_ERROR` with message
    `"daemon panic"` (does not match the race regex). Procedure throws
    `INTERNAL_SERVER_ERROR`. Audit row `task.kill.error`, payload code
    `"MCP_RPC_ERROR"`.
11. **Task not found.** No seed. Procedure throws `NOT_FOUND`. **No**
    audit row, **no** MCP call.
12. **Input validation — id=0.** `BAD_REQUEST`. No DB lookup, no MCP
    call, no audit.
13. **Input validation — id=-1.** `BAD_REQUEST`.
14. **Input validation — id=1.5.** `BAD_REQUEST`.
15. **MCP_TIMEOUT** → tRPC `TIMEOUT`; audit `task.kill.error`, code
    `"MCP_TIMEOUT"`.
16. **MCP_BACKPRESSURE** → `TOO_MANY_REQUESTS`.
17. **MCP_CONNECTION_LOST** → `INTERNAL_SERVER_ERROR`.
18. **MCP_SPAWN_FAILED** → `INTERNAL_SERVER_ERROR`.
19. **MCP_ABORTED** → `CLIENT_CLOSED_REQUEST`.
20. **`ctx.req` propagates to audit.** With `x-forwarded-for: 5.6.7.8`
    + `JWT_SECRET` set, `ip_hash` is non-null on the success audit row.
21. **`ctx.userId` null** → audit row `user_id IS NULL`.
22. **Idempotency — repeated call.** Seed `running`. First call
    succeeds (MCP returns ok). Then mutate the row to `status=killed`
    (simulating the daemon's post-kill update). Second call returns
    `alreadyTerminated: true` without calling MCP. Two audit rows in
    the table, both `action="task.kill"`.

## Implementation outline

### `src/server/routers/tasks.ts` (extend)

```ts
const KillInput = z.object({
  id: z.number().int().positive(),
});

const KILL_TIMEOUT_MS = 15_000;

const TERMINAL_STATUSES = new Set(["done", "failed", "killed"]);

const RACE_PATTERN = /no.*running|not.*running|already.*(done|terminated|killed|finished)/i;

interface KillResult { ok: true; alreadyTerminated: boolean; }

kill: publicProcedure
  .input(KillInput)
  .mutation(async ({ input, ctx }): Promise<KillResult> => {
    if (!ctx.mcp) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", ... });

    const db = getDb();
    const row = db.select({ status: tasks.status, agentName: agents.name })
      .from(tasks).leftJoin(agents, eq(tasks.sessionId, agents.sessionId))
      .where(eq(tasks.id, input.id)).limit(1).all()[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "task not found" });

    const auditBase = { resourceType: "task" as const,
                        resourceId: String(input.id),
                        userId: ctx.userId ?? null, req: ctx.req };

    // Path A — server-side terminal check (no MCP call).
    if (row.status && TERMINAL_STATUSES.has(row.status)) {
      appendAudit({ ...auditBase, action: "task.kill",
        payload: { agentName: row.agentName, status: row.status,
                   alreadyTerminated: true } });
      return { ok: true, alreadyTerminated: true };
    }

    // Path B — call MCP.
    try {
      await ctx.mcp.call("bridge_kill", { agent: row.agentName ?? "" },
                         { timeoutMs: KILL_TIMEOUT_MS });
    } catch (err) {
      // Race: daemon says the task is no longer running. Treat as ok.
      if (err instanceof McpPoolError && err.code === "MCP_RPC_ERROR"
          && RACE_PATTERN.test(err.message)) {
        appendAudit({ ...auditBase, action: "task.kill",
          payload: { agentName: row.agentName, status: row.status,
                     alreadyTerminated: true, raceDetected: true } });
        return { ok: true, alreadyTerminated: true };
      }
      appendAudit({ ...auditBase, action: "task.kill.error",
        payload: { agentName: row.agentName, code: auditFailureCode(err) } });
      throw mapMcpErrorToTrpc(err);
    }

    appendAudit({ ...auditBase, action: "task.kill",
      payload: { agentName: row.agentName, status: row.status,
                 alreadyTerminated: false } });
    return { ok: true, alreadyTerminated: false };
  }),
```

### `src/server/dto.ts` (extend)

Add `KillResult` wire type:

```ts
export interface KillResult {
  ok: true;
  alreadyTerminated: boolean;
}
```

## Risk + mitigation

| Risk (PHASE-2-REVIEW §c.T03) | Mitigation |
|------------------------------|------------|
| Idempotency race — user clicks Kill on a task that just finished | Two-layer guard: (a) server-side `TERMINAL_STATUSES` check before MCP, (b) regex match on daemon "not running" / "already terminated" → swallow → `alreadyTerminated: true`. Both paths audit, neither throws. |
| Daemon `bridge_kill` is *agent-scoped*, dashboard `kill(id)` is *task-scoped* | Procedure resolves task → agent via the existing left-join. If the row has no agent (orphan task — agent deleted), `agentName` is `null`; we still pass `""` to the daemon and let it MCP_RPC_ERROR back ("agent not found") → maps to `INTERNAL_SERVER_ERROR`. Edge case noted. |
| User kills two tasks on the same agent in rapid succession | Daemon-side race — out of scope for the dashboard. Each MCP call is independent; we audit per-call. Daemon must serialise (concurrent BEGIN IMMEDIATE on its end). |
| RACE_PATTERN false-positive — daemon error message accidentally matches | The regex is intentionally tight (`no.*running` / `not.*running` / `already.*(done\|terminated\|killed\|finished)`). It does **not** match generic errors like `"connection refused"` or `"agent not found"`. Tests #7-9 vs #10 verify. |
| Audit-write-after-throw | Same pattern as T01: `appendAudit(...)` is called *before* `throw mapMcpErrorToTrpc(err)`. |
| User keeps clicking Kill spamming the daemon | Per-user mutation rate-limit (T07) caps at 30/min/user → 429. The "already terminated" early-return path also bypasses MCP entirely, so even an unkilled spam loop on a `done` task hits SQLite, not the daemon. |
| Confirmation dialog (T11) lands later → kill is "naked" today | Acceptable — server side ships now, UI confirmation pattern arrives in T11 and reuses this procedure unchanged. |
