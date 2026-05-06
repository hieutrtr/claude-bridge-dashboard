-- P4-T06 — `notification_preferences` table (dashboard-owned).
--
-- Stores per-user toggle matrix for in-app, email-digest, and (stub)
-- browser-push channels. One row per active `users.id`. Rows are
-- created lazily on first read (`notifications.preferences()` calls
-- `findOrCreatePreferences`). Defaults are PRIVACY-FIRST:
--   * in_app_enabled       = TRUE  (already on the page; no opt-in needed)
--   * email_digest_enabled = FALSE (opt-in per Phase 4 invariant)
--   * email_digest_hour    = 9     (local-TZ; sent when scheduled hour matches)
--   * email_digest_tz      = 'UTC' (callers can override; the digest
--                                   job converts via `Intl` at send time)
--   * browser_push_enabled = FALSE (stub — UI shows the permission
--                                   button but actual push delivery
--                                   ships in v0.2.0; T06-review §3)
--
-- Hour bounds (0..23) are CHECK-constrained so a UI bug or rogue
-- mutation cannot poison the digest job's `strftime('%H', 'now')`
-- comparison. TZ string length capped at 64 chars (longest IANA TZ
-- string is ~32 chars; 64 leaves headroom without enabling abuse).
--
-- Foreign key on `user_id` with `ON DELETE CASCADE` so revoking a
-- user via the soft-delete `revoked_at` does NOT delete prefs (we
-- keep the row for audit / restoration), but a hard delete cascades.
-- Soft deletion is the canonical path — revoke leaves prefs intact.
--
-- All statements are IF NOT EXISTS — runMigrations is idempotent and
-- safe under concurrent dashboard processes.

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id              TEXT    PRIMARY KEY,
  in_app_enabled       INTEGER NOT NULL DEFAULT 1 CHECK (in_app_enabled IN (0, 1)),
  email_digest_enabled INTEGER NOT NULL DEFAULT 0 CHECK (email_digest_enabled IN (0, 1)),
  email_digest_hour    INTEGER NOT NULL DEFAULT 9 CHECK (email_digest_hour BETWEEN 0 AND 23),
  email_digest_tz      TEXT    NOT NULL DEFAULT 'UTC' CHECK (length(email_digest_tz) BETWEEN 1 AND 64),
  browser_push_enabled INTEGER NOT NULL DEFAULT 0 CHECK (browser_push_enabled IN (0, 1)),
  updated_at           INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_preferences_email_digest
  ON notification_preferences (email_digest_enabled, email_digest_hour)
  WHERE email_digest_enabled = 1;
