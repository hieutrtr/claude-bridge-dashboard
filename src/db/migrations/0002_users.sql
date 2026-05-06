-- P4-T01 — `users` table (dashboard-owned).
--
-- Stores every dashboard identity. `id` is a UUID generated client-side
-- when a magic-link consume creates the row (or hard-coded `"owner"`
-- for the env-password fallback identity backfilled lazily on first use).
-- `email_lower` is a generated stored column used for case-insensitive
-- lookup (CITEXT does not exist in SQLite). `revoked_at` is NULL until
-- soft-delete; queries filter `revoked_at IS NULL` to show active rows.
--
-- All statements are IF NOT EXISTS — runMigrations is idempotent and
-- safe under concurrent dashboard processes (see src/server/migrate.ts).

CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY,
  email         TEXT    NOT NULL,
  email_lower   TEXT    GENERATED ALWAYS AS (lower(email)) STORED,
  role          TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  display_name  TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  revoked_at    INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (email_lower);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_revoked_at ON users (revoked_at);
