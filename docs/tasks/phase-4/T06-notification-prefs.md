# T06 — Notification preferences + email digest

> **Phase:** 4 (Polish & Multi-user) · **Iter:** 7/16 · **Status:** done · **Risk:** Medium · **Depends:** T01 (`users` table) + T02 (router pattern + Resend client)

## Goal

Give every authenticated dashboard user a per-channel toggle matrix
(in-app, email-digest, browser-push) plus a daily email digest job
that summarises the last 24h of their tasks. Default state is
**privacy-first**: in-app on, every other channel **off**. The
email digest is opt-in by construction — the migration default for
`email_digest_enabled` is `0`, no codepath flips it to `1` without
an explicit user mutation, and the row is never created on behalf of
the user (lazy `findOrCreatePreferences` runs on first read).

The digest job is a standalone CLI script (`scripts/email-digest.ts`)
with all logic in `src/server/email-digest.ts` so it is testable
without spawning a process. The script can run via OS cron OR via
the daemon's `bridge_schedule_add` MCP tool — both are documented
in the script header.

Browser-push is a deferred **stub**: the toggle records a boolean
and asks the browser for permission, but the dashboard does not
actually deliver pushes in v0.1.0. Filed against v0.2.0 in the
phase INDEX.

## Surface delivered

### Migration `src/db/migrations/0004_notification_preferences.sql`

`notification_preferences (user_id PRIMARY KEY → users.id)` with
columns:

| column                 | type    | default | constraint                          |
|------------------------|---------|---------|-------------------------------------|
| `user_id`              | TEXT    | —       | PRIMARY KEY, FK → `users.id` ON DELETE CASCADE |
| `in_app_enabled`       | INTEGER | `1`     | `IN (0, 1)`                         |
| `email_digest_enabled` | INTEGER | `0`     | `IN (0, 1)` — **opt-in**            |
| `email_digest_hour`    | INTEGER | `9`     | `BETWEEN 0 AND 23`                  |
| `email_digest_tz`      | TEXT    | `'UTC'` | length 1..64                        |
| `browser_push_enabled` | INTEGER | `0`     | `IN (0, 1)` — stub                  |
| `updated_at`           | INTEGER | —       | NOT NULL                            |

Plus a partial index `WHERE email_digest_enabled = 1` so the digest
job's recipient query stays cheap as the user table grows.

### Helper `src/server/notification-prefs.ts`

Pure SQL surface — no router or HTTP imports. Exposes:

| Export                         | Purpose                                                                    |
|--------------------------------|----------------------------------------------------------------------------|
| `findPreferences`              | Read by `user_id`. Returns `null` for never-touched accounts.             |
| `findOrCreatePreferences`      | Read-on-miss insert with the migration defaults. Used by both router + digest job. |
| `updatePreferences`            | Partial update; returns the row + the list of changed keys (drives the audit `changes:[]` field). |
| `listEmailDigestRecipients`    | JOIN `notification_preferences ↔ users WHERE email_digest_enabled = 1 AND revoked_at IS NULL`. |
| `DEFAULT_PREFS`                | Const used by the `notifications.reset` mutation.                          |

The helper module is shared by the digest job + router so an op
running `bun run scripts/email-digest.ts` never touches tRPC state
machines.

### Router `src/server/routers/notifications.ts`

| Procedure                            | Type     | RBAC          | Behaviour                                                                                  |
|--------------------------------------|----------|---------------|--------------------------------------------------------------------------------------------|
| `notifications.preferences()`        | Query    | authedProcedure | Returns the caller's prefs row, creating it lazily with defaults on first read.            |
| `notifications.update({...})`        | Mutation | authedProcedure | Partial update. At least one field required. Validates `emailDigestHour` 0..23 + tz regex. |
| `notifications.reset()`              | Mutation | authedProcedure | Restores every field to migration defaults. DangerConfirm-wrapped client side.             |

Self-only by construction — every procedure pulls `ctx.user.id` from
the RBAC middleware and writes against that id directly. There is
no admin surface for editing other users' prefs.

### Audit invariant

| Action                                | Payload                                              |
|---------------------------------------|------------------------------------------------------|
| `notification.preferences-update`     | `{ changes: [<key>, ...] }` — KEY NAMES ONLY        |
| `notification.preferences-reset`      | `{ changes: [<key>, ...] }`                          |
| `notification.email-digest-sent`      | `{ targetEmailHash, taskCount, totalCostUsd }`       |
| `notification.email-digest-skipped`   | `{ targetEmailHash, reason: "resend_not_configured", taskCount }` |
| `notification.email-digest-failed`    | `{ targetEmailHash, reason: "resend_error"\|"resend_network", status? }` |

The `changes:` array is the diff between persisted state and the
incoming partial update — never the new value, never the old value,
never the timezone string. The digest audits use `targetEmailHash`
(SHA-256(lowercase(trim(email)) + ":" + salt)) — the same shape
T01 introduced for magic-link audits, so privacy queries that
correlate magic-link request → consume → digest send all run
against one column type.

### UI `app/settings/notifications/page.tsx` + `src/components/notifications-form.tsx`

Server component reads `auth.me` + `notifications.preferences`,
delegates rendering to a client form. The form:

* Toggle switches for in-app / email-digest / browser-push (radix
  `role="switch"` for AA — verified manually; full axe-core run lands
  in T10).
* Hour `<select>` + IANA TZ text input (only visible when
  `emailDigestEnabled = true`).
* Optimistic UI on every toggle (instant flip, server-confirmed,
  reverts on error).
* `<DangerConfirm verb="Reset" subject="notification preferences"
  expectedConfirmation="reset">` for the destructive reset action
  (matches Phase 4 invariant T06 §5).

Browser-push toggle calls `Notification.requestPermission()` when
flipping ON. The permission outcome doesn't gate the toggle — the
bool is recorded regardless so the user's intent is captured for
v0.2.0 push delivery.

### Email digest job `scripts/email-digest.ts` + `src/server/email-digest.ts`

```
              ┌──────────────────────────────────────────────┐
              │  scripts/email-digest.ts (CLI wrapper)       │
              │   • reads env (RESEND_API_KEY, …)            │
              │   • opens DB via existing pool               │
              │   • prints one-line cron-friendly summary    │
              └────────────────────┬─────────────────────────┘
                                   │
              ┌────────────────────▼─────────────────────────┐
              │  src/server/email-digest.ts (orchestrator)   │
              │   • selectRecipientsForHour(now)             │
              │   • for each: buildDigestSummary +           │
              │              renderDigestEmail +             │
              │              sendDigest (fetch → Resend) +   │
              │              audit row                       │
              └──────────────────────────────────────────────┘
```

`localHourFor(now, tz)` uses `Intl.DateTimeFormat` so DST + offset
shifts are handled correctly (verified for UTC, Asia/Saigon +7,
America/Los_Angeles -7 PDT). An invalid TZ returns `null` and the
recipient is skipped silently — the job records audit so the
operator can fix the misconfigured row.

Render output includes a one-click unsubscribe link
(`/settings/notifications`) per RFC 8058 spirit, and HTML-escapes
the recipient + agent names so a malicious agent name cannot inject
HTML into the email body.

### Test coverage (48 new tests, all passing)

| File                                              | Tests | Notes                                            |
|---------------------------------------------------|------:|--------------------------------------------------|
| `tests/server/notifications-router.test.ts`       | 18    | RBAC entrance, defaults, partial/multi update, validation, self-only, reset. |
| `tests/server/email-digest.test.ts`               | 14    | TZ conversion, recipient selection, summary aggregation, HTML escape, send/skip/fail audits. |
| `tests/lib/notifications-client.test.ts`          | 16    | HOURS, formatHour, tz validator, request builders, parseTrpcResponse, diffPrefs. |

Plus updates to `tests/lib/nav.test.ts` (Notifications nav entry, 8
items now).

## Acceptance check vs INDEX (T06 row)

| Criterion                                                        | Status |
|------------------------------------------------------------------|--------|
| preferences persist across sessions                              | ✅ Read-on-miss insert backs the persistence; `findPreferences` returns the same row across new caller instances (verified in router tests). |
| email digest delivered once per 24h at chosen hour ±5min (TZ-aware) | ✅ `localHourFor` resolves the recipient's TZ via `Intl`; `selectRecipientsForHour` picks rows where `local hour == configured hour`; cron runs at the top of every hour so the digest fires within 5 min of the configured hour. **Caveat**: there is no `last_sent_at` watermark, so a duplicate cron run within the same hour COULD send twice — filed against v0.2.0 (see T06 review §2). |
| browser-push stub shows native permission prompt + records the bool but does NOT yet send pushes | ✅ Toggle calls `Notification.requestPermission()` when flipping ON; the bool is recorded irrespective of the permission outcome; no push delivery codepath exists. |

## Phase 4 invariant checklist

- [x] CSRF + 30/min/user rate-limit (existing tRPC POST guards apply
      to `notifications.update` + `notifications.reset` automatically).
- [x] RBAC — every procedure uses `authedProcedure`. Self-only by
      construction; no cross-user write surface.
- [x] `appendAudit` actions `notification.preferences-update`,
      `notification.preferences-reset`, plus three digest job
      actions (`-sent` / `-skipped` / `-failed`). Every audit
      payload encodes KEY NAMES ONLY for the prefs change set, and
      `targetEmailHash` for digest send rows. **Email plaintext is
      never persisted in `audit_log`** — verified by string-not-contains
      assertions in both test suites.
- [x] DangerConfirm on the `reset` action (matches Phase 4 invariant
      §5).
- [x] Optimistic UI on individual toggles (matches Phase 4 invariant
      §6 + P2-T10 precedent). Reset is server-confirmed.
- [x] Mobile-first — every component renders under 390px width
      (verified manually; Lighthouse pass lands in T07).
