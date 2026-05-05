# P2-T06 — `loops.approve` / `loops.reject` via MCP

> Third mutation in Phase 2 — first procedure on a brand-new
> `loopsRouter`. Reuses the guarded-mutation stack already stood up by
> T12 (transport pool), T08 (CSRF), T07 (rate-limit), T04 (audit) and
> the error-mapping helpers from T01 (`mapMcpErrorToTrpc` /
> `auditFailureCode`). Critical wrinkle vs T01 / T03: **multi-channel
> race** — the same `pending_approval` loop can be approved on the
> dashboard while the user simultaneously rejects on Telegram. The
> daemon must serialise (CAS / `BEGIN IMMEDIATE`); the dashboard
> procedure adds a *defensive* server-side guard so the second click
> degrades to a no-op `alreadyFinalized:true` rather than a confusing
> `INTERNAL_SERVER_ERROR`.

## References

- v2 IMPLEMENTATION-PLAN P2-T6 — *"in `/tasks/[id]` task detail, when
  the task is part of a loop in `pending_approval`, render Approve /
  Reject buttons. tRPC `loops.approve({ loopId })` /
  `loops.reject({ loopId, reason? })` mutations call MCP
  `bridge_loop_approve` / `bridge_loop_reject`. **Server-confirmed UI**
  — no optimistic update for this mutation per review §d.1."*
- v1 ARCH §4.3 — wire signatures `loops.approve({ loopId })` and
  `loops.reject({ loopId, reason? })`.
- v1 ARCH §10 — every mutation writes one `audit_log` row (success +
  failure). Resource type = `"loop"`, resource id = `loopId`.
- INDEX (this phase) §"Phase 2 invariant" — same five rules as T01 / T03.
- `docs/PHASE-2-REVIEW.md` §c risk row — T06 = **High** (multi-channel
  race) + §d.1 (server-confirm; no optimistic UI).
- T01 / T03 specs (`docs/tasks/phase-2/T0{1,3}-*.md`) — call-shape /
  audit / error-mapping pattern; reuse `mapMcpErrorToTrpc` +
  `auditFailureCode` + `RACE_PATTERN` style guard.
- CLAUDE.md (bot dir) §"bridge_loop_approve" / "bridge_loop_reject" —
  daemon MCP tool signatures: `bridge_loop_approve({ loop_id })`,
  `bridge_loop_reject({ loop_id, feedback? })`. Dashboard normalises
  `reason → feedback` at the boundary so the UI keeps the v1 wire
  vocabulary.
- `src/db/schema.ts` — `loops` table: `loopId` (PK, string),
  `status` (`running|done|cancelled|...`),
  `pendingApproval` (boolean, the gate this procedure flips).

## Scope

- New tRPC `loopsRouter` registered at `loops.*` in `_app.ts`. Two
  mutation procedures only — `approve` and `reject`. (`list` / `get`
  / `start` / `cancel` / `stream` are left for later — Phase 3 covers
  the `/loops` page; this loop only adds the inline approve/reject
  surface.)
- Both procedures look up the loop row first via the existing
  `loops` Drizzle table; resolve a loop → `{ status, pendingApproval }`
  pair from the canonical SQLite source rather than trusting the
  client's view of state.
- Both procedures call into the daemon via the T12 pool — *no*
  `child_process.spawn`. Tool names + param shape:
  - `bridge_loop_approve({ loop_id })`
  - `bridge_loop_reject({ loop_id, feedback? })`
- Reuse `mapMcpErrorToTrpc` + `auditFailureCode`. Race-pattern regex
  swallows the daemon's "already approved / rejected / finalized /
  finished" responses and converts them into
  `{ ok: true, alreadyFinalized: true, raceDetected: true }` audit
  rows (mirrors T03).
- Audit rows always written (success + failure). Resource type
  `"loop"`, resource id = `loopId` (string — stored verbatim in
  `audit_log.resource_id`).

## Non-goals

- The Approve / Reject buttons + the "loop is pending approval" UI —
  that lives in `/tasks/[id]` and lands in T11 (confirmation pattern)
  + the dispatch dialog UI (T02) cycle on the same page. T06 only
  ships the server procedures.
- **Optimistic UI** — *explicitly out of scope per review §d.1.* The
  client awaits the daemon ACK before flipping the row's
  `pending_approval` indicator. T10 wires optimistic updates only for
  dispatch + kill.
- `loops.cancel` — the v1 `loops.*` router has cancel, but the v2
  IMPLEMENTATION-PLAN P2-T6 scope is `approve` / `reject` only.
  Cancel is deferred to Phase 3 (when the `/loops` page lands).
- Audit-log read surface — that is T05 (`/audit` page).
- Anti-double-click guard on the client — handled in T11 via the
  `<DangerConfirm>` primitive. The procedure is server-idempotent
  via the `pending_approval` check + race-pattern swallow, so a
  double-click can never blow up.

## Acceptance criteria

1. **Procedure shape.** Both `loops.approve` and `loops.reject` are
   tRPC `mutation`s on a new `loopsRouter`, registered as `loops` in
   `_app.ts`. POST only; the route handler's CSRF (T08) +
   rate-limit-mutations (T07) guards apply uniformly.
2. **Input validation — approve.** `loops.approve` Zod input is
   `{ loopId: string (1-128 chars) }`. Empty / oversize / non-string
   → `BAD_REQUEST`.
3. **Input validation — reject.** `loops.reject` Zod input is
   `{ loopId: string (1-128), reason?: string (1-1000) }`. Empty
   loopId or oversize reason → `BAD_REQUEST`. Missing reason is
   permitted (sent on the wire as `undefined`, NOT empty string).
4. **Loop not found.** Unknown `loopId` → tRPC `NOT_FOUND` with
   message *"loop not found"*. **No** audit row (mirrors T03 — we
   don't log probes).
5. **Already finalized — server-side check.** When the lookup row's
   `pendingApproval` is `false`, the procedure returns
   `{ ok: true, alreadyFinalized: true }` **without calling MCP**.
   One audit row appended:
   `{ action: "loop.approve" | "loop.reject",
      resource_type: "loop", resource_id: loopId,
      payload: { status, alreadyFinalized: true } }`.
6. **Approve happy path.** When `pendingApproval=true`, the procedure
   calls `bridge_loop_approve({ loop_id: loopId })` with timeout
   `15_000`. On success returns `{ ok: true, alreadyFinalized: false }`.
   One audit row:
   `{ action: "loop.approve", resource_id: loopId,
      payload: { status, alreadyFinalized: false } }`.
7. **Reject happy path — no reason.** `pendingApproval=true`,
   `reason` omitted → `bridge_loop_reject({ loop_id: loopId })`
   (no `feedback` key in params — the daemon treats absence as
   "no feedback"). Returns `{ ok: true, alreadyFinalized: false }`.
   Audit payload `{ status, alreadyFinalized: false }` —
   **`reason` is NOT echoed into the audit payload** (it may carry
   user-private text; the daemon retains it on the loop row).
8. **Reject happy path — with reason.** `pendingApproval=true`,
   `reason="bad output"` → MCP params
   `{ loop_id: loopId, feedback: "bad output" }`. Same return shape
   as #7. Audit row payload still excludes the reason text but
   carries `hasReason: true` for forensic correlation with the loop
   row.
9. **Race — daemon says "already approved/rejected/finalized".**
   When the daemon throws
   `McpPoolError("MCP_RPC_ERROR", message)` and the message matches
   `/already.*(approved|rejected|finalized|finished|done|cancell?ed)|loop.*not.*pending|not.*pending.*approval/i`,
   the procedure swallows the error and returns
   `{ ok: true, alreadyFinalized: true }`. Audit payload:
   `{ status, alreadyFinalized: true, raceDetected: true }`. Other
   `MCP_RPC_ERROR` messages propagate normally.
10. **Pool errors map per T01.** Reuse `mapMcpErrorToTrpc` +
    `auditFailureCode` for `MCP_TIMEOUT`, `MCP_BACKPRESSURE`,
    `MCP_CONNECTION_LOST`, `MCP_SPAWN_FAILED`, `MCP_ABORTED`, generic
    `MCP_RPC_ERROR`. Audit row on error is
    `{ action: "loop.approve.error" | "loop.reject.error",
       resource_id: loopId,
       payload: { status, code } }` written **before** the throw.
11. **Idempotency — repeated approve.** Calling `loops.approve` twice
    on the same loop, where the first call succeeded and the daemon
    has flipped `pending_approval=false`, returns
    `{ ok: true, alreadyFinalized: true }` on the second call (no
    MCP call). Two audit rows in the table — neither throws.
12. **Idempotency — approve then reject (multi-channel race).**
    Same as #11 but the second call is `loops.reject`: still hits
    the early-return path (server-side check sees
    `pendingApproval=false`) → `alreadyFinalized: true`. The audit
    row is `loop.reject` (the *attempted* action), not `loop.approve`.
13. **`ctx.req` propagates.** Same as T01 / T03 — when
    `x-forwarded-for` and `JWT_SECRET` are set, `ip_hash` is non-null
    on the success audit row. `user-agent` propagates.
14. **`ctx.userId` propagates.** Same as T01 / T03.
15. **No daemon side-effect on dashboard-side terminal check.** The
    "already finalized" early-return path in criterion 5 does *not*
    call MCP — verified by `mcp.calls.length === 0`. Avoids spamming
    the daemon on a stale browser tab.
16. **Resource id is the string loopId.** Unlike T03 where
    `resource_id` is `String(taskId)` (autoincrement int → string),
    `audit_log.resource_id` here is the loop's text PK verbatim.
    The audit viewer (T05) joins `audit_log.resource_id =
    loops.loop_id` directly.

## TDD plan (RED → GREEN)

File: `tests/server/loops-router.test.ts` (new)

Setup mirrors `kill-router.test.ts` (tmp DB on disk so the procedure
can resolve the loops lookup, `runMigrations`, `__setAuditDb`,
`fakePool` helper). The new bit: seed the `loops` table so the
lookup join finds rows.

```ts
function seedLoop(db: Database, opts: {
  loopId: string;
  agent?: string;
  status?: string;
  pendingApproval?: boolean;
}) {
  // INSERT INTO loops (loop_id, agent, project, goal, done_when,
  //   status, pending_approval, total_cost_usd, started_at, ...)
}
```

Tests:

1. **Approve — happy path.** Seed `loop_id="loop-1"`,
   `pendingApproval=true`. `mcp.call` resolves with `{ ok: true }`.
   Procedure returns `{ ok: true, alreadyFinalized: false }`. MCP
   call shape: method `"bridge_loop_approve"`, params
   `{ loop_id: "loop-1" }`, timeoutMs 15_000. One audit row,
   `action="loop.approve"`, `resource_type="loop"`,
   `resource_id="loop-1"`, payload
   `{ status: "running", alreadyFinalized: false }`.
2. **Reject — happy path with reason.** Seed `pendingApproval=true`.
   Call `loops.reject({ loopId: "loop-2", reason: "bad output" })`.
   MCP params `{ loop_id: "loop-2", feedback: "bad output" }`.
   Audit row `action="loop.reject"`, payload
   `{ status: "running", alreadyFinalized: false, hasReason: true }`.
   The reason text is NOT in `payload_json` (privacy).
3. **Reject — no reason.** `loops.reject({ loopId: "loop-3" })`.
   MCP params `{ loop_id: "loop-3" }` (no `feedback` key). Audit
   payload omits `hasReason` or sets it false.
4. **Already finalized — pending_approval=false.** Seed
   `pendingApproval=false`, `status="running"`. Procedure returns
   `{ ok: true, alreadyFinalized: true }` without calling MCP
   (`calls.length === 0`). Audit payload includes
   `alreadyFinalized: true`. Repeat for `status="done"` and
   `status="cancelled"`.
5. **Loop not found.** No seed. `loops.approve({ loopId: "ghost" })`
   throws `NOT_FOUND`. **No** audit row, **no** MCP call. Same for
   `loops.reject`.
6. **Race patterns swallowed (approve).** Seed
   `pendingApproval=true`. `mcp.call` throws
   `McpPoolError("MCP_RPC_ERROR", "loop already approved")`.
   Procedure returns `{ ok: true, alreadyFinalized: true }`. Audit
   payload includes `alreadyFinalized: true, raceDetected: true`.
   Test variants: `"already rejected"`, `"already finalized"`,
   `"loop not pending approval"`, `"already finished"`,
   `"already cancelled"`.
7. **Race patterns swallowed (reject).** Same shape but with
   `loops.reject`. Audit `action="loop.reject"`.
8. **Generic MCP_RPC_ERROR — does NOT swallow.** Daemon message
   `"daemon panic: out of memory"`. Procedure throws
   `INTERNAL_SERVER_ERROR`. Audit row `loop.approve.error` /
   `loop.reject.error` with `code="MCP_RPC_ERROR"`.
9. **Input validation — empty loopId.** Both procedures →
   `BAD_REQUEST`. No DB lookup, no MCP call, no audit.
10. **Input validation — oversize loopId (>128 chars).**
    `BAD_REQUEST`.
11. **Input validation — oversize reason (>1000 chars).**
    `loops.reject` → `BAD_REQUEST`.
12. **Pool errors map.** Same five-row table as T03 — `MCP_TIMEOUT`
    → `TIMEOUT`, `MCP_BACKPRESSURE` → `TOO_MANY_REQUESTS`, etc.
    Audit row `loop.approve.error` / `loop.reject.error` with the
    pool code.
13. **`ctx.req` propagates.** With `x-forwarded-for: 5.6.7.8` +
    `user-agent: ua/1` + `JWT_SECRET` set, audit success row has
    `ip_hash` non-null and `user_agent="ua/1"`.
14. **`ctx.userId` null** → audit `user_id IS NULL`.
15. **Idempotency — repeated approve.** Seed
    `pendingApproval=true`. First call succeeds (MCP returns ok).
    Then mutate the row to `pendingApproval=false` (simulating the
    daemon's post-approve update). Second call returns
    `alreadyFinalized:true` without MCP. Two audit rows, both
    `loop.approve`.
16. **Idempotency — approve then reject (multi-channel race).**
    Same setup as #15 but second call is `loops.reject`. Returns
    `alreadyFinalized:true`. Audit rows: `[loop.approve,
    loop.reject]` — second carries the *attempted* action.

## Implementation outline

### `src/server/routers/loops.ts` (new)

```ts
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { publicProcedure, router } from "../trpc";
import { getDb } from "../db";
import { loops } from "../../db/schema";
import { appendAudit } from "../audit";
import { McpPoolError } from "../mcp/pool";
import { auditFailureCode, mapMcpErrorToTrpc } from "../mcp/errors";
import type { LoopApproveResult, LoopRejectResult } from "../dto";

const ApproveInput = z.object({
  loopId: z.string().min(1).max(128),
});
const RejectInput = z.object({
  loopId: z.string().min(1).max(128),
  reason: z.string().min(1).max(1000).optional(),
});

const LOOP_TIMEOUT_MS = 15_000;
const LOOP_RACE_PATTERN =
  /already.*(approved|rejected|finalized|finished|done|cancell?ed)|loop.*not.*pending|not.*pending.*approval/i;

interface LoopRow {
  status: string | null;
  pendingApproval: boolean;
}

function lookupLoop(loopId: string): LoopRow | undefined {
  const db = getDb();
  return db
    .select({ status: loops.status, pendingApproval: loops.pendingApproval })
    .from(loops)
    .where(eq(loops.loopId, loopId))
    .limit(1)
    .all()[0];
}

export const loopsRouter = router({
  approve: publicProcedure
    .input(ApproveInput)
    .mutation(async ({ input, ctx }): Promise<LoopApproveResult> => {
      // 1. require ctx.mcp
      // 2. lookup; NOT_FOUND if missing
      // 3. early-return alreadyFinalized=true if !pendingApproval
      // 4. mcp.call("bridge_loop_approve", { loop_id })
      // 5. catch McpPoolError race-pattern → swallow
      // 6. audit success / error
    }),

  reject: publicProcedure
    .input(RejectInput)
    .mutation(async ({ input, ctx }): Promise<LoopRejectResult> => {
      // identical shape; pass `feedback` only if reason !== undefined
      // payload may include `hasReason: true` (do NOT echo reason)
    }),
});
```

### `src/server/dto.ts` (extend)

```ts
export interface LoopApproveResult {
  ok: true;
  alreadyFinalized: boolean;
}

export interface LoopRejectResult {
  ok: true;
  alreadyFinalized: boolean;
}
```

(Two distinct DTOs even though shape is identical — keeps the wire
contract per-procedure so a future `reason` echo / extra metadata
doesn't break the other.)

### `src/server/routers/_app.ts` (extend)

Add `loops: loopsRouter` to the appRouter.

## Risk + mitigation

| Risk (PHASE-2-REVIEW §c.T06) | Mitigation |
|------------------------------|------------|
| Multi-channel race — same loop approved on web, rejected on Telegram simultaneously | Two-layer guard: (a) server-side `pendingApproval=false` check before MCP — captures the case where Telegram landed first and updated the row; (b) regex match on daemon "already approved / rejected / finalized" → swallow → `alreadyFinalized:true`. Both paths audit, neither throws. The *daemon* still owns the source of truth (BEGIN IMMEDIATE / CAS); the dashboard contributes a graceful UX layer. |
| User clicks Approve and Reject in rapid succession (web only) | Same race guard. The first mutation flips `pendingApproval=false`, the second hits the early-return path. Both audited so the trail is complete. UI confirmation pattern (T11) makes this UX-unlikely; the procedure is *correct* either way. |
| Loop pending → never resolves (daemon stuck) | Out of scope for the procedure. The pool's 15 s timeout (T12) caps the call latency; if the daemon hangs longer the user gets `TIMEOUT` and can retry. |
| `reason` text leaks into audit | Audit payload records `hasReason: true` only — the reason text is held in the daemon (and in the user's mind). The dashboard never persists the rejection rationale, so an audit-log dump cannot expose it. |
| RACE_PATTERN false-positive — unrelated daemon error matches | The regex requires `already.*(approved\|rejected\|finalized\|finished\|done\|cancell?ed)` OR `(loop.*not.*pending\|not.*pending.*approval)`. Generic errors like `"agent not found"` or `"connection refused"` do not match → propagate as `INTERNAL_SERVER_ERROR`. Tests #6-7 vs #8 verify. |
| Audit-write-after-throw | Same pattern as T01 / T03: `appendAudit(...)` runs *before* `throw mapMcpErrorToTrpc(err)`. |
| User spams Approve while daemon hangs → T07 rate-limit catches | Per-user mutation rate-limit (T07) caps at 30/min/user. The early-return path also bypasses MCP for already-finalized loops, so a stuck-button retry loop hits SQLite, not the daemon. |
| `pendingApproval` boolean is daemon-owned column (drizzle introspect) | Drizzle schema (`src/db/schema.ts`) declares `pending_approval` as `integer({ mode: "boolean" })`; the procedure reads it as `boolean` and the early-return guard uses `!row.pendingApproval`. If the daemon adds a tri-state value later we'll surface a type error here, not a silent bypass. |
| No optimistic UI per review §d.1 | Encoded as a *non-goal*. The mutation surface is server-confirmed; the spinner-then-flip is the UX. T10 explicitly excludes loops.approve / loops.reject from optimistic wiring. |
