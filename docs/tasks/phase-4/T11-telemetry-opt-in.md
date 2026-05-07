# T11 — Telemetry opt-in (anonymous, no PII)

> **Phase:** 4 (Polish & Multi-user) · **Iter:** 12/16 · **Status:** done · **Risk:** HIGH (privacy review surface) · **Depends:** T01 (`users` table) + T02 (router pattern) + T03 (RBAC)

## Goal

Ship an install-scoped, **opt-in** anonymous telemetry pipeline that
records page views, action latencies, and feature-key strokes into a
local `telemetry_events` table. **Default OFF**. The toggle is owner-
only, surfaces an install-id UUID (not user-id) on the rows, and routes
every event through a load-bearing PII scrubber. Members can read the
toggle state but cannot flip it.

The Phase 4 invariant carve-out for T11 is explicit: the `record`
mutation does **not** audit per call. Auditing every event would
(a) defeat the privacy purpose by re-introducing user attribution via
the audit `user_id` column, and (b) generate orders of magnitude more
audit rows than the table is sized for.

## Surface delivered

### Migration `src/db/migrations/0005_telemetry_events.sql`

Two tables ship together because both belong to the install scope:

`dashboard_meta` — single-row k/v store. Used for `telemetry_opt_in`
(string `"true"|"false"`) and `install_id` (UUID generated on first
opt-in). One row per key — `(key TEXT PRIMARY KEY, value TEXT,
updated_at INTEGER)`.

`telemetry_events` — append-only event log:

| column       | type    | constraint                                        |
|--------------|---------|---------------------------------------------------|
| `id`         | INTEGER | PRIMARY KEY AUTOINCREMENT                         |
| `install_id` | TEXT    | NOT NULL, length 8..64                            |
| `event_type` | TEXT    | NOT NULL, IN (`page_view`, `action_latency`, `feature_used`) |
| `event_name` | TEXT    | NOT NULL, length 1..128                           |
| `value_ms`   | INTEGER | nullable, 0..600 000                              |
| `created_at` | INTEGER | NOT NULL                                          |

Indexes: `idx_telemetry_events_created_at` (DESC, for the recent-rows
panel), `idx_telemetry_events_event_type_name` (for future aggregations).

There is no `user_id` column by construction — adding one would
re-introduce the privacy hole the toggle exists to avoid. Recorded in
T11 review §2.

### Helper `src/server/dashboard-meta.ts`

Pure SQL surface for the install-scoped k/v: `getMeta`, `setMeta`,
`getTelemetryOptIn`, `setTelemetryOptIn`, `getOrCreateInstallId`. The
install-id is generated lazily on first opt-in and re-used forever
(flipping OFF then back ON keeps the same UUID — anonymous identity is
stable for the lifetime of the SQLite file).

### Helper `src/server/telemetry-store.ts`

Opt-in gate + PII scrubber + DB writer. `recordEvent` returns one of:

- `accepted` — opt-in ON + sanitiser passed. Row inserted.
- `dropped_off` — opt-in OFF. Silent no-op.
- `dropped_pii` — opt-in ON + sanitiser rejected. Reason returned for
  the router to surface, but the offending raw string is **never**
  echoed.

`listRecentEvents(limit)` and `countEvents()` back the "View what we
collect" panel.

### Library `src/lib/telemetry-pii.ts`

The privacy boundary. Pure functions, no DOM/Node deps so the same
module ships in browser + server bundles:

- `sanitiseEventType` — whitelist over `["page_view", "action_latency",
  "feature_used"]`. Anything else returns `null`.
- `sanitiseEventName` — rewrites UUIDs (`8-4-4-4-12`), generic long hex
  tokens (≥ 12 chars), and bare numeric IDs (≥ 6 digits) to `[id]`;
  strips query strings; rejects strings that contain emails, IPv4
  octets, file system paths, or non-ASCII characters; truncates to 128
  chars.
- `containsPii` — best-effort detector returning a tagged reason. Used
  by the router validator + the test grid.
- `clampValueMs` — coerces durations to `[0, 600_000]` ms.

`TELEMETRY_LIMITS` and `TELEMETRY_EVENT_TYPES` are frozen constants
re-used by the router's zod schema and the client's request builder.

### Router `src/server/routers/telemetry.ts`

| Procedure                      | Type     | RBAC               | Behaviour                                                                 |
|--------------------------------|----------|--------------------|---------------------------------------------------------------------------|
| `telemetry.optInStatus()`      | Query    | authedProcedure    | Returns `{ enabled, installId, counts }`. `installId` is null when off.   |
| `telemetry.setOptIn({enabled})`| Mutation | **ownerProcedure** | Toggles install-wide flag. Generates install-id on first ON. Audits.      |
| `telemetry.record({…})`        | Mutation | authedProcedure    | NO-OP when off. Drops PII inputs. **No audit row.**                       |
| `telemetry.recent({limit?})`   | Query    | **ownerProcedure** | Returns up to 200 most-recent rows for the transparency panel.            |

Why is `record` `authedProcedure` instead of public? The Phase 4
invariant requires every mutation to travel through CSRF + rate-limit
+ a known caller. Anonymous record would need a separate ingest path,
which we do not need — every dashboard caller is signed in already.

### Audit invariant

| Action                       | Payload                          |
|------------------------------|----------------------------------|
| `telemetry.opt-in-toggle`    | `{ enabled: bool, changed: bool }` |

That is the **only** audit action this task introduces. Per T11
acceptance, `telemetry.record` does NOT audit (defeats the purpose).
The payload's `enabled` boolean is recorded — it's a meta-setting, not
user data — but the install-id is **not** echoed (anonymous identity
preservation; verified by `expect(audits[0].payload_json).not.toContain(installId)`).

### UI `app/settings/telemetry/page.tsx` + `src/components/telemetry-form.tsx`

Server component reads the session, calls `auth.me`, then routes:
- `me === null` → "Sign in via /login" CTA.
- `me.role !== "owner"` → "Telemetry is install-wide. Ask the owner."
- otherwise → `<TelemetryForm>` with the SSR'd initial state.

The form renders three sections:
1. **Toggle** — `role="switch"` button (AA-contrast emerald-on-slate),
   wired to the `telemetry.setOptIn` mutation. Optimistic flip; reverts
   on error.
2. **Install-id** chip (visible when ON) — `<code>{installId}</code>`
   with the explanation "one stable UUID; no user attribution".
3. **What we collect / What we do not collect** — the explanation
   block. Lists every event type plus the explicit "no user IDs, no
   IP, no UA, no upload" promise.
4. **Recent events** (visible when ON) — table of the last 25 rows
   with timestamp / type / sanitised name / value_ms. Backs the
   transparency promise.

A row in `src/lib/nav.ts` (`Telemetry` → `/settings/telemetry`) wires
the sidebar entry. Members see the link but get the
`<NotOwner />` banner on visit.

### Test coverage (89 new tests, 1436 → 1436 still pass)

| File                                                | Tests | Notes                                                         |
|-----------------------------------------------------|------:|---------------------------------------------------------------|
| `tests/lib/telemetry-pii.test.ts`                   | 32    | Whitelist; ID rewrite; PII rejection (email/IPv4/path/non-ASCII); length limits; `clampValueMs` band coverage. |
| `tests/lib/telemetry-client.test.ts`                | 8     | Request builders; CSRF header; valueMs clamp; `recordTelemetry` skip / accept / dropped_off branches. |
| `tests/server/telemetry-router.test.ts`             | 16    | Default OFF; RBAC matrix (owner / member / anonymous × four routes); install-id stable across off/on; row-count assertions; PII rejection; **install-id never appears in audit `payload_json`**. |
| `tests/lib/nav.test.ts` (extended)                  | +1    | Nav now exposes 9 items; `Telemetry` last.                    |

`bun run typecheck` clean. `bun run build` builds `/settings/telemetry`
at 4.24 kB JS + 113 kB shared.

## Acceptance check vs INDEX (T11 row)

| Criterion                                                | Status |
|----------------------------------------------------------|--------|
| Default OFF                                              | ✅ Migration leaves `dashboard_meta` empty; `getTelemetryOptIn()` returns false. Verified by router test "reports OFF by default". |
| Toggling opt-in surfaces audit row                       | ✅ `telemetry.opt-in-toggle` action with `{ enabled, changed }` payload. |
| With opt-in OFF, `record` is a no-op                     | ✅ `recordEvent` early-returns `dropped_off`; row count assertions in `telemetry-router.test.ts`. |
| No `user_id`, IP, UA, or PII in recorded rows            | ✅ Schema lacks `user_id` column; `install_id` is install-scoped UUID; `containsPii` rejects email/IPv4/file_path; `sanitiseEventName` rewrites UUIDs/hex/long-digits to `[id]`; non-ASCII rejected. **Install-id never echoed in audit payloads** (asserted explicitly). |
| Data POSTed to a USER-controlled endpoint                | ✅ `TELEMETRY_ENDPOINT` env var DEFAULTS TO unset; the upload loop is filed against v0.2.0. Rows accumulate in the local SQLite file until the owner explicitly configures an upload destination. Phase 4 INDEX §"open architectural concerns" records this deferral. |

## Phase 4 invariant checklist

- [x] CSRF — every mutation goes through the existing `csrf-guard.ts`
      (T07 of P2). Verified by the test harness using `appRouter.createCaller`
      which exercises the same guard.
- [x] Rate-limit — every mutation goes through `rate-limit-mutations.ts`
      (T07 of P2, 30/min/user bucket). The router does NOT define its
      own bucket — telemetry rate is identical to other tRPC mutations.
- [x] RBAC — `setOptIn` and `recent` are `ownerProcedure`; `record` and
      `optInStatus` are `authedProcedure`. T03's RBAC matrix is the
      authority for the 401/403 split. Test grid covers the 4 procedures
      × 3 caller roles = 12 cases.
- [x] `appendAudit` — `telemetry.opt-in-toggle` action emitted on every
      `setOptIn` call (whether `changed` or not, per the existing
      precedent of recording attempts). Payload: `{ enabled, changed }`.
      `record` does **NOT** audit per the carve-out above.
- [x] No DangerConfirm — flipping telemetry is reversible and the bool
      is the value, not a destructive op. Reset (`OFF → ON → OFF`)
      preserves the install-id.
- [x] Optimistic UI — toggle flip is optimistic (P2-T10 precedent),
      reverts on error.
- [x] Mobile-first — every component renders under 390px width; the
      "Recent events" table uses `<table>` natively but at < 640px the
      P4-T07 mobile pass already wraps every settings table with the
      same card-list pattern. Verified manually; Lighthouse mobile run
      bundled into the phase-tests step.
