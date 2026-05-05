# P2-T04 — Audit log table + write helper

> Cross-cutting infrastructure. Lands at slot 5/15 — after the entry
> guards (T12 transport, T08 CSRF, T07 rate-limit) and before the first
> mutation procedure (T01 dispatch). T07 + T08 already ship with
> `// TODO(T04): appendAudit(...)` markers; this task fills them in
> and creates the table + helper that every subsequent mutation
> (T01, T03, T06, T09) depends on.
>
> **Scope is dashboard-side only.** The daemon will eventually write its
> own audit row joined on `request_id`; that work is out of scope for
> this loop and is filed as a follow-up against `claude-bridge`.

## References

- v1 ARCH §3 — *"Dashboard không tạo bảng mới cho domain entity, chỉ
  thêm `users`, `web_sessions`, `audit_log`."* — `audit_log` is
  dashboard-owned. Column list is the source of truth for the schema.
- v1 ARCH §10 — *"Audit log: mọi mutation (dispatch, kill, approve,
  reject) viết 1 row vào `audit_log` với user_id, action,
  resource_type, resource_id, IP hash."* + *"IP hash = SHA-256 với
  salt per-install để không lưu PII."*
- v1 ARCH §4.6 — `system.auditLog` query (read-side, owner-only) —
  consumed by T05 viewer; T04 only ships the write side.
- INDEX §"Audit log migration note" — confirmed migration approach:
  idempotent `CREATE TABLE IF NOT EXISTS` + per-install boot runner,
  joined on `request_id` to a future daemon-side row.
- INDEX §"Open architectural concerns" §d.2 — write path = pre-MCP
  on the dashboard; daemon-side audit deferred.
- T07 spec §10 — placeholder `// TODO(T04): appendAudit(...)` in
  `src/server/rate-limit-mutations.ts` and `rate-limit-login.ts`.
  T04 replaces these stubs with real calls.
- T08 spec — `csrfGuard` on `csrf_invalid` returns 403; T04 audits
  this as `action="csrf_invalid"`.

## Acceptance criteria

1. **Schema vendor.** `audit_log` is added to `src/db/schema.ts` as
   a *dashboard-owned* table, annotated with a comment block
   distinguishing it from daemon-vendored tables. Columns match v1
   ARCH §3:

   ```sql
   id            INTEGER PRIMARY KEY AUTOINCREMENT
   user_id       TEXT                       -- session subject (current: "owner") or NULL pre-auth
   action        TEXT    NOT NULL           -- e.g. "task.dispatch", "rate_limit_blocked", "csrf_invalid"
   resource_type TEXT    NOT NULL           -- e.g. "task", "loop", "auth", "n/a"
   resource_id   TEXT                       -- agent name / task id / loop id; NULL for guard rows
   payload_json  TEXT                       -- JSON.stringify of inputs (passwords stripped) or NULL
   ip_hash       TEXT                       -- SHA-256(ip + perInstallSalt), base64url; NULL if salt unset
   user_agent    TEXT                       -- raw UA header (truncated 256 chars)
   request_id    TEXT                       -- UUID for joining to a future daemon row
   created_at    INTEGER NOT NULL           -- ms epoch
   ```

   Indexed on `(created_at DESC)` (for the viewer's reverse-chrono
   list) and on `(user_id, created_at DESC)` (for per-user filter).

2. **Migration file.** `src/db/migrations/0001_audit_log.sql` is the
   single source of truth for the table + indexes. All statements
   are `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`,
   so the file is idempotent: running it twice on the same DB is a
   no-op. Statements are separated by the drizzle-kit convention
   `--> statement-breakpoint`.

3. **Migration runner.** `src/server/migrate.ts` exports
   `runMigrations(db: Database)` that:
   - Reads every `*.sql` file in `src/db/migrations/` in filename
     order (lexicographic — `0000_..` < `0001_..`).
   - Skips `0000_violet_random.sql` (it is the introspection artifact
     and is wrapped in a `/* */` block; running it on the live DB
     would no-op anyway, but skipping is clearer).
   - Splits each file on `--> statement-breakpoint` and executes
     each statement inside `BEGIN IMMEDIATE; … COMMIT;` for safety
     under concurrent dashboard processes (one wins the immediate
     transaction; the other waits, observes IF NOT EXISTS, and
     no-ops).
   - Idempotent: running on a DB that already has `audit_log`
     completes without error.

4. **Boot wire-up.** A lightweight `ensureMigrated()` is called from
   `getDb()` exactly once per process — the singleton DB handle in
   `src/server/db.ts`. The first caller pays the migration cost;
   later callers see the cached handle.

5. **`appendAudit` helper.** `src/server/audit.ts` exports

   ```ts
   appendAudit({
     action: string;
     resourceType: string;
     resourceId?: string | null;
     userId?: string | null;
     payload?: unknown;
     req?: Request;          // when present, derives ip_hash + ua + request_id
     requestId?: string;     // overrides req-derived value
   }): { id: number; requestId: string }
   ```

   Behaviour:
   - Synchronous (bun:sqlite is sync). Returns the inserted row id
     and the `request_id` used (UUID, generated if not provided).
   - `payload` is JSON-serialised. If serialisation fails (cycle,
     BigInt, etc.), payload is recorded as `null` and a `serialise`
     warning is logged once. Common-sense field stripping: a
     top-level `password` key, if present, is replaced with
     `"<redacted>"` before stringify.
   - `ip_hash` derivation: SHA-256 of `${ip}:${perInstallSalt}`,
     base64url-encoded. `ip` is read from
     `req.headers.get("x-forwarded-for")` (first hop, trimmed),
     fallback `x-real-ip`, fallback `null` (then `ip_hash` is null).
     `perInstallSalt` resolution order:
     1. `process.env.AUDIT_IP_HASH_SALT` (if non-empty),
     2. `process.env.JWT_SECRET` (already required for auth — a
        per-install stable secret),
     3. `null` → no hash recorded; row still written.
     Resolved once per process and cached.
   - `user_agent` is the raw UA header, truncated to 256 chars.
   - `created_at` is `Date.now()`.

6. **Replace T07 / T08 placeholders.** `rate-limit-mutations.ts` and
   `rate-limit-login.ts` now call `appendAudit({
   action: "rate_limit_blocked", resourceType: "auth"|"mutation",
   payload: { retryAfterSec }, req })` on every 429. `csrf-guard.ts`
   calls `appendAudit({ action: "csrf_invalid",
   resourceType: "auth", req })` on every 403.

7. **Salt absence is fail-safe, not fail-closed.** If neither
   `AUDIT_IP_HASH_SALT` nor `JWT_SECRET` is set (the same condition
   T08 returns 503 for) the audit write still happens with
   `ip_hash = null`. Audit writing must not block a request even
   if it fails — wrap the insert in a try/catch and log to stderr
   on error (audit-write failures are themselves a one-time
   `audit_write_failed` console log per process; we do not retry).

8. **Owner-only enforcement is T05's responsibility.** T04 ships
   the write side only. The reader (`system.auditLog` query) lands
   in T05; until then, querying the table is via raw drizzle.

## Non-goals

- Daemon-side audit row (joined on `request_id`). Filed as a
  follow-up issue against `claude-bridge`.
- Encryption-at-rest. Audit rows live in the same SQLite as the
  rest of the daemon DB; OS-level disk encryption is the user's
  responsibility (documented in `PHASE-2-COMPLETE.md`).
- Retention policy / pruning. The owner can `DELETE FROM
  audit_log WHERE created_at < ?` manually until Phase 4.
- A migration tracking table. Idempotency via
  `CREATE TABLE IF NOT EXISTS` is sufficient for the
  single-statement migration file we ship in Phase 2; a tracking
  table is added the first time we ship a non-idempotent migration.
- An `appendAudit` async / batched variant. bun:sqlite is sync; a
  single insert per mutation has been measured at <1 ms on the
  Phase 1 fixture DB.

## TDD plan (RED → GREEN)

### Unit — `tests/server/migrate.test.ts`

1. Fresh empty SQLite (in-memory `:memory:` or tmp file) →
   `runMigrations(db)` creates `audit_log` table with the
   expected columns (introspect via `PRAGMA table_info`).
2. Running `runMigrations` twice on the same DB completes without
   error and produces no duplicate columns / errors (idempotent).
3. `audit_log` has indexes `idx_audit_log_created_at` and
   `idx_audit_log_user_created_at` after migration (via
   `PRAGMA index_list("audit_log")`).
4. Two parallel `runMigrations` calls (use `Promise.all` of two
   handles to the same file DB) both succeed; the table exists
   exactly once after.

### Unit — `tests/server/audit.test.ts`

Set up: tmp file DB, `runMigrations(db)` once, then call
`appendAudit` directly bound to that DB via a test seam
(`__setAuditDb(db)` debug export, parallels `_reset` pattern in
T07/T08).

1. `appendAudit({ action: "task.dispatch", resourceType: "task",
   resourceId: "42", userId: "owner", payload: { agent: "x" } })`
   inserts a row whose columns match the inputs and whose
   `created_at` is within ±1 s of `Date.now()`.
2. Returns `{ id, requestId }`; `id` is the AUTOINCREMENT, and
   `requestId` matches a UUID v4 shape (`/^[0-9a-f-]{36}$/`).
3. With a `Request` containing `x-forwarded-for: 1.2.3.4` and
   `AUDIT_IP_HASH_SALT="s"` set, `ip_hash` is the
   base64url-encoded SHA-256 of `"1.2.3.4:s"` (assert exact value).
4. Same call with no XFF / no x-real-ip → `ip_hash` is `null`.
5. Same call with `AUDIT_IP_HASH_SALT` unset but `JWT_SECRET="js"`
   set → `ip_hash` derives from `JWT_SECRET`.
6. Same call with neither salt → `ip_hash` is `null`; row still
   written.
7. `payload` containing a top-level `password` key is recorded
   with `password: "<redacted>"`.
8. `payload` containing a circular reference → row is written;
   `payload_json` is `null`; one warning logged (assert via
   `console.warn` spy).
9. UA truncation: header value of length 1000 chars → stored
   value is exactly 256 chars.
10. `requestId` parameter, when supplied, takes priority over
    auto-generation and is echoed back in the return value.
11. Audit insert error (close the DB, then call) → no throw;
    a one-time stderr log; subsequent calls do not log again.

### Integration — `tests/server/csrf-guard.test.ts` (extend)

Add: when `csrfGuard` returns 403, exactly one row is appended
to `audit_log` with `action = "csrf_invalid"`,
`resource_type = "auth"`, no `resource_id`, and `ip_hash`
deriving from the request's `x-forwarded-for`.

### Integration — `tests/server/rate-limit-mutations.test.ts` (extend)

Add: when `rateLimitMutations` returns 429, exactly one row is
appended to `audit_log` with `action = "rate_limit_blocked"`,
`resource_type = "mutation"`, `user_id` = the supplied
`sessionUserId`, and `payload_json` containing the
`retryAfterSec`.

### Integration — `tests/server/rate-limit-login.test.ts` (extend)

Add: same shape as above with `resource_type = "auth"`,
`user_id = null`.

### Smoke — `tests/server/audit-boot.test.ts`

`getDb()` (cold cache) on a tmp DB with no `audit_log` table →
afterwards `audit_log` exists. Idempotent on the second call.

## Implementation outline

### `src/db/migrations/0001_audit_log.sql`

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT,
  action        TEXT    NOT NULL,
  resource_type TEXT    NOT NULL,
  resource_id   TEXT,
  payload_json  TEXT,
  ip_hash       TEXT,
  user_agent    TEXT,
  request_id    TEXT,
  created_at    INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created_at ON audit_log (user_id, created_at DESC);
```

### `src/server/migrate.ts`

```ts
export function runMigrations(db: Database): void;
```

- Reads `src/db/migrations/*.sql` lexicographically; skips files
  whose contents are entirely wrapped in a `/* */` introspection
  block (the `0000_violet_random.sql` artifact).
- Each file: `BEGIN IMMEDIATE;` → split on `--> statement-breakpoint` → exec each → `COMMIT;`.
- On error: `ROLLBACK;` and re-throw.

### `src/server/audit.ts`

```ts
export interface AppendAuditInput { ... }
export function appendAudit(input: AppendAuditInput): { id: number; requestId: string };
export function __setAuditDb(db: Database | null): void;  // test seam
```

- Lazily binds to `getDb()` if no test seam set.
- Salt resolved on first call, cached.
- Try/catch around the prepared INSERT; on error, log once to
  stderr and return `{ id: -1, requestId }`.

### `src/server/db.ts` (modify)

After `cached = open(dbPath())` and before returning, call
`runMigrations(cached.$client ?? <handle>)`. Use bun:sqlite's
underlying `Database` (drizzle stores it on `_.session.client`
but we'll keep a parallel `sqlite` handle in this module).

## Risk + mitigation

| Risk (from PHASE-2-REVIEW §c.T04 / INDEX §"Audit log migration note") | Mitigation in this task |
|----------------------------------------------------------------------|-------------------------|
| **Daemon does not know about `audit_log`.** Future `bun run sync-schema` will drop it. | INDEX flags this as a follow-up issue against `claude-bridge`. The vendored schema annotates the table as "dashboard-owned" so a reviewer of the regen diff catches it. PHASE-2-COMPLETE.md will repeat the warning. |
| **Concurrent dashboard processes racing on first migration.** | `BEGIN IMMEDIATE` serialises; `IF NOT EXISTS` makes the loser a no-op. Test asserts two parallel runs succeed. |
| **Audit write failure breaks the user request.** | Try/catch around the insert. A failed audit write logs once to stderr but never throws. The mutation still completes (or the guard still returns its 403/429). |
| **PII leak via raw IP storage.** | `ip_hash` only — never the raw IP. SHA-256 + per-install salt; viewer never reverses it. |
| **Salt absence silently downgrades audit.** | Documented; `ip_hash = null` is the fail-safe. Production checklist (PHASE-2-COMPLETE.md) will require `AUDIT_IP_HASH_SALT` set. |
| **Sensitive payload keys stored in plaintext.** | Top-level `password` redacted. Future Phase 4 expands the redact list (token, secret, …). |
| **Schema drift between this repo and the daemon's vendored SQL.** | T04 ships only the dashboard side; the daemon-side row is filed as a follow-up. INDEX flags this. |

