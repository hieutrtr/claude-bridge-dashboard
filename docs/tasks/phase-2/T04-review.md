# P2-T04 — Self-review

> Cross-cutting infrastructure for every Phase 2 mutation. Replaces the
> `// TODO(T04): appendAudit(...)` placeholders in T07 (rate-limit-mutations
> + rate-limit-login) and T08 (csrf-guard) with real audit writes.

## Files changed

### New

- `src/db/migrations/0001_audit_log.sql` — schema for the dashboard-owned
  `audit_log` table; idempotent `IF NOT EXISTS` statements separated by
  `--> statement-breakpoint`.
- `src/server/migrate.ts` — generic migration runner. Reads `*.sql` files
  from `src/db/migrations/` lexicographically, skips the drizzle-kit
  introspection artifact, executes each remaining file inside `BEGIN
  IMMEDIATE … COMMIT`. Test seam `runMigrations(db, { dir })`.
- `src/server/audit.ts` — `appendAudit({ action, resourceType, resourceId?,
  userId?, payload?, req?, requestId? }) → { id, requestId }`. SHA-256
  IP hash via `node:crypto` (sync, base64url). Test seams
  `__setAuditDb(db|null)` + `__resetAudit()` keyed on `globalThis` so
  fresh module reloads (the `?t=…` URL trick used by T07/T08 tests)
  share state.
- `tests/server/migrate.test.ts` — fresh-DB columns, idempotency,
  data preservation, parallel-process safety.
- `tests/server/audit.test.ts` — basic insert, requestId override,
  ip_hash via salt env / JWT_SECRET fallback / null when unset, XFF
  first-hop, x-real-ip fallback, password redaction, cycle handling,
  UA truncation, DB-closed resilience.
- `tests/server/audit-boot.test.ts` — `getDb()` first call triggers
  `runMigrations`; `getSqlite` and `getDb` share one underlying handle.
- `tests/server/audit-integrations.test.ts` — csrfGuard 403, rate-limit
  mutations 429, rate-limit login 429 each emit exactly one audit row
  with the expected shape.
- `docs/tasks/phase-2/T04-audit-log.md` — task spec.

### Modified

- `src/db/schema.ts` — added `auditLog` table to the Drizzle vendor,
  inside a clearly-marked "DASHBOARD-OWNED" comment block to flag the
  drift on the next `bun run db:introspect`.
- `src/server/db.ts` — `getDb()` now ensures migrations are run on first
  access; new `getSqlite()` exposes the underlying `bun:sqlite` Database
  for raw inserts (the audit module). `resetDb()` now also closes the
  cached SQLite handle for hygiene.
- `src/server/csrf-guard.ts` — `invalid()` now takes `req` and writes a
  `csrf_invalid` audit row before returning 403.
- `src/server/rate-limit-mutations.ts` — on 429, writes a
  `rate_limit_blocked` row with `resourceType: "mutation"`, `userId`,
  and `payload: { retryAfterSec }`.
- `src/server/rate-limit-login.ts` — on 429, writes a
  `rate_limit_blocked` row with `resourceType: "auth"` and
  `payload: { retryAfterSec, scope: "login" }`.

## Test count

- `tests/server/migrate.test.ts` — 5 test cases.
- `tests/server/audit.test.ts` — 14 test cases.
- `tests/server/audit-boot.test.ts` — 3 test cases.
- `tests/server/audit-integrations.test.ts` — 4 test cases.

**Suite delta:** before T04, the scoped run had 328 tests; after, **354
pass / 0 fail / 2505 expect() calls** (`bun run test`). Two stderr
warnings appear in the audit failure-resilience test — they are the
expected "warned once" log lines (`audit: payload serialise failed …`
and `audit: write failed …`), asserted-on indirectly by the suppression
behaviour of the next call.

`bun run typecheck` — clean. `bun run build` — clean (Next.js production
build, all 12 routes compile).

## Self-review checklist

- [x] **Tests cover happy + error path.** Empty DB → table created;
  missing salt → null hash; closed DB → no throw, return `{id:-1,…}`;
  cycle in payload → null payload_json + one-shot warn; UA over 256
  chars → truncated; explicit requestId honoured; 429/403 each writes
  exactly one row.
- [x] **Mutation has audit log entry?** N/A for this task — T04 ships
  the helper itself. The first mutation procedure (T01 dispatch, slot
  6) is the first user of `appendAudit({ action: "task.dispatch", … })`.
  T07 + T08 already use it (placeholders replaced).
- [x] **CSRF token check?** N/A for this task — T04 is invoked *from*
  `csrf-guard.ts` after the check fails. No new HTTP handler is added
  by T04.
- [x] **Rate limit applied?** N/A for this task — same as above. T04
  is invoked from `rate-limit-mutations.ts` / `rate-limit-login.ts`
  on the 429 path.
- [x] **Optimistic update has rollback?** N/A — server-side helper.
- [x] **Confirmation pattern for destructive action?** N/A — this is
  an internal append-only writer; the user never sees it.
- [x] **No secret leak.** `AUDIT_IP_HASH_SALT` and `JWT_SECRET` are
  only ever read at the audit module's salt-resolve step, never
  written to the row. The salt itself is one-way-hashed before
  storage. Top-level `password` keys in the `payload` object are
  redacted to `<redacted>` before `JSON.stringify` (see
  `sanitisePayload`). `user-agent` headers are truncated to 256
  characters to bound storage but are not redacted further (UA
  fingerprinting risk is on the storage owner — this matches v1 ARCH
  §10's policy).

## Other notes

- **Migration runner is intentionally minimal.** No tracking table,
  no version checks, no down-migrations. Every statement we ship is
  `IF NOT EXISTS`-guarded; the file is named `0001_…` so a future
  drift-checker can reason about ordering. The first time a
  non-idempotent migration is needed, a `_dashboard_migrations` table
  is added.
- **Why bun:sqlite directly (not Drizzle) in `appendAudit`?** Drizzle's
  `bun-sqlite` driver is sync, but using its query builder for a single
  `INSERT … RETURNING id` adds a layer of typing that drifts against
  the migration's column list. The raw prepared statement makes the
  contract more explicit and skips one allocation per call. The Drizzle
  vendor entry is kept up-to-date for the T05 reader (which *does* use
  Drizzle for the filter UI).
- **Salt-fallback to `JWT_SECRET`** — pragmatic: `JWT_SECRET` is already
  required for any auth to work, so falling back to it means a default
  install always salts. Phase 4 (multi-user) should split these two
  secrets into independent rotation cycles.
- **Daemon-side audit row** — out of scope. The `request_id` column is
  populated on every dashboard write; whenever the daemon adds its
  own audit table we can join the two views without re-emitting from
  the dashboard. Filed as a follow-up against `claude-bridge`
  (referenced in `INDEX.md` and to be repeated in
  `PHASE-2-COMPLETE.md`).
- **No retention policy.** `audit_log` grows monotonically until an
  operator runs `DELETE FROM audit_log WHERE created_at < ?` manually.
  Phase 4 will add a configurable retention.
- **Why the `globalThis`-keyed test seam?** The T07/T08 test files
  reload modules with `?t=Math.random()` URL queries to defeat Bun's
  module cache, which means transitive imports also re-evaluate. A
  module-local `db` variable would be cleared on every reload; storing
  it on `globalThis` mirrors the `__bridge_rate_limit_*__` pattern
  used by the same test files.
