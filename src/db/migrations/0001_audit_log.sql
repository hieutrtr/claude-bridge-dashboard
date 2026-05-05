-- T04 — dashboard-owned audit_log table.
--
-- Columns track v1 ARCHITECTURE.md §3 (`audit_log`). Indexed on
-- (created_at DESC) for the viewer's reverse-chronological list, and on
-- (user_id, created_at DESC) for per-user filters. All statements are
-- IF NOT EXISTS so the file is idempotent under concurrent dashboard
-- processes — see src/server/migrate.ts.
--
-- This table is OWNED BY THE DASHBOARD, not the daemon. A future
-- daemon-side audit row (joined on `request_id`) will be filed as a
-- separate issue against `claude-bridge`.

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
