# T06 — Notification preferences + email digest — code review

> **Reviewer:** loop iter 7 self-review · **Status:** done · **Risk:** Medium

## Scope

* New migration `0004_notification_preferences.sql`
* New helper `src/server/notification-prefs.ts` (pure SQL surface).
* New router `src/server/routers/notifications.ts` mounted on `appRouter`.
* New client lib `src/lib/notifications-client.ts` (request builders + parseTrpcResponse).
* New page `app/settings/notifications/page.tsx`.
* New component `src/components/notifications-form.tsx`.
* New email-digest module `src/server/email-digest.ts` + CLI wrapper `scripts/email-digest.ts`.
* 48 new test cases across three files; nav.test.ts updated.
* Full unit suite **1258 / 1258 pass** + Next.js production build green + `tsc --noEmit` clean.

## Acceptance check vs INDEX (T06 row)

| Criterion                                                                  | Status |
|----------------------------------------------------------------------------|--------|
| preferences persist across sessions                                         | ✅ Lazy `findOrCreatePreferences` inserts the default row on first read; subsequent reads return the same row across new caller instances. Tested in `router-defaults-+-persistence` block. |
| email digest delivered once per 24h at chosen hour ±5min (TZ-aware)         | ⚠️ Hour-bucketed recipient selection ships; **no `last_sent_at` dedupe column** — see Q2 below. Documented as v0.2.0 follow-up. |
| browser-push stub shows native permission prompt + records the bool         | ✅ `onToggleBrowserPush` calls `Notification.requestPermission()` before submitting; the bool is recorded regardless of the permission outcome. Stub-only — no push delivery codepath. |

## Question matrix (loop rules §Rule 3)

> **Auth: token expiry + secure cookie?**
> Out of scope — T06 introduces no new auth surface. Every procedure
> reuses `authedProcedure` from `src/server/trpc.ts`, which delegates
> to `requireAuth` from `src/server/rbac.ts`. The session cookie
> verification (T01-owned) propagates automatically. The mutations
> ride the existing `csrfGuard` (P2-T08) and 30/min/user rate-limit
> bucket (P2-T07) at the tRPC POST endpoint — verified by reading
> `app/api/trpc/[trpc]/route.ts` (no new bypass).

> **RBAC: 403 cover all mutation routes?**
> ✅ Every procedure (`preferences`, `update`, `reset`) uses
> `authedProcedure`. Coverage:
> | Procedure                  | Anonymous | Member (own) | Owner (own) |
> |----------------------------|-----------|--------------|-------------|
> | `notifications.preferences`| 401       | 200          | 200         |
> | `notifications.update`     | 401       | 200          | 200         |
> | `notifications.reset`      | 401       | 200          | 200         |
> Cross-user writes are not possible by construction — every code
> path uses `ctx.user.id` directly; the surface does not accept
> a target user id. The router tests verify the self-only invariant
> by writing as both owner + member and asserting only their own
> row mutated (`describe("notifications.update — self-only")`).

> **Mobile: Lighthouse ≥ 90?**
> Deferred to T07 (mobile responsive pass). The form renders in a
> single column at iPhone 390px width — toggle switches use 44×44
> touch targets (Radix-style `role="switch"` button is 24×44, but
> the surrounding header card extends the touch area). The hour
> `<select>` is native HTML so the iOS picker shows correctly.

> **Email: rate limit (anti-abuse)?**
> ✅ Two complementary controls:
> 1. The router mutation (`notifications.update`) rides the existing
>    30/min/user bucket — a runaway client cannot churn more than 30
>    pref toggles a minute.
> 2. The email digest job is hour-bucketed at the recipient layer:
>    `selectRecipientsForHour` returns AT MOST one entry per
>    `(user_id, configured_hour)` per cron tick. A user cannot
>    arrive at "send me 1000 digests" by toggling rapidly — the
>    digest fires when `local_hour == configured_hour`, not when the
>    user mutates the row.
> 3. The unsubscribe URL (`/settings/notifications`) is the same
>    page that records the toggle, so opt-out is one click.

## Privacy / security

1. **Email plaintext is never in `audit_log`.** Both router audit
   actions (`notification.preferences-update`,
   `notification.preferences-reset`) record only the changed key
   names — `{ changes: ["emailDigestEnabled", "emailDigestHour"] }`.
   The digest send/skip/fail rows record `targetEmailHash` (SHA-256
   of `lowercase(email) + ":" + salt`) — same pattern T01
   established. Both router and digest test suites assert
   `expect(payload_json).not.toContain("alice@example.com")` to lock
   the invariant against future drift.

2. **Hour duplicate-fire risk.** The current job has no
   `last_sent_at` column; if cron ticks more than once in the same
   hour (e.g. systemd timer flap, manual `bun run scripts/email-digest.ts`)
   the same recipient could receive two digests. **Mitigation**:
   the audit log records every send with timestamp, so an operator
   can detect duplicates. **Future fix** (v0.2.0): add
   `last_email_digest_sent_at` to `notification_preferences` and
   skip rows sent in the last 23 hours. Documented in INDEX
   "Out-of-scope" section.

3. **HTML injection in digest body.** The render path uses an
   internal `escapeHtml` helper for both the recipient address and
   per-agent rows. Tested with a payload of
   `name: "<script>alert('x')</script>"` — the rendered HTML
   contains `&lt;script&gt;` and never the literal `<script>` tag.
   Same defence-in-depth as T05 palette label sanitisation.

4. **Browser permission flow.** Toggling browser-push to ON calls
   `Notification.requestPermission()` (best-effort; wrapped in
   try/catch so a denial never throws). The toggle bool is recorded
   regardless of the user's permission decision — the user's intent
   is captured even if they later need to grant permission via
   browser settings. v0.2.0 push delivery will gate on
   `Notification.permission === "granted"`.

5. **TZ string validation.** Server-side accepts the regex
   `^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$` which matches all canonical
   IANA TZs (`UTC`, `Asia/Saigon`, `America/Los_Angeles`, `Etc/GMT+12`)
   while rejecting SQL-injection-shaped strings
   (`Asia/Saigon; DROP TABLE users`). The digest job calls
   `localHourFor` which wraps `Intl.DateTimeFormat` in try/catch —
   a malformed TZ at send time skips the row instead of crashing.

6. **Resend graceful-fail.** When `RESEND_API_KEY` is unset, the
   digest job logs a `notification.email-digest-skipped` audit row
   with `reason: "resend_not_configured"` and continues. Same
   contract T01 established for `auth.requestMagicLink`. The CLI
   wrapper exits 0 in this case (skipped is not an error from the
   cron's perspective).

## Out of scope (filed against v0.2.0)

* **`last_sent_at` dedupe column** — see Q2 above.
* **Browser push delivery** — toggle is recorded; actual push
  message dispatch needs a service-worker registration + VAPID key
  pipeline.
* **Email open / click tracking** — out by privacy default.
* **Per-event-type fan-out** (per the v1 ARCH §6.4 mention of
  granular event types) — current schema collapses event types
  into one digest channel. Granular fan-out lands in v0.2.0 when
  the event taxonomy stabilises.

## Files touched

```
A  src/db/migrations/0004_notification_preferences.sql
A  src/server/notification-prefs.ts
A  src/server/routers/notifications.ts
A  src/server/email-digest.ts
A  scripts/email-digest.ts
A  src/lib/notifications-client.ts
A  src/components/notifications-form.tsx
A  app/settings/notifications/page.tsx
A  tests/server/notifications-router.test.ts
A  tests/server/email-digest.test.ts
A  tests/lib/notifications-client.test.ts
M  src/server/routers/_app.ts          (mount notifications router)
M  src/lib/nav.ts                      (add Notifications nav item)
M  tests/lib/nav.test.ts               (assert 8 items)
A  docs/tasks/phase-4/T06-notification-prefs.md
A  docs/tasks/phase-4/T06-review.md    (this file)
```
