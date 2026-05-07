-- P4-T11 — telemetry tables (dashboard-owned). Privacy-first.
--
-- Bridge ships with telemetry **OFF by default**. Two tables back the
-- toggle:
--
--   `dashboard_meta`     — single-row k/v store for the install scope.
--                          Used to persist `telemetry_opt_in` (string
--                          "true" | "false") and `install_id` (UUID
--                          generated on first opt-in). Stored once-per-
--                          install, never per-user.
--   `telemetry_events`   — append-only event log. Each row is anonymous:
--                          install-scoped, never user-scoped, never
--                          IP/UA/email/path-with-id. Records ONLY
--                          page_view / action_latency / feature_used.
--
-- Why a `dashboard_meta` k-v table instead of a column on `users`?
-- The opt-in is install-wide (one boolean flips the recorder for every
-- caller) and `users` may not exist yet at first dashboard boot — env-
-- password owner has no `users` row until the first session. Decoupling
-- meta from users lets the toggle work even before any user has logged
-- in via magic-link.
--
-- Why no `user_id` column on `telemetry_events`?
-- The Phase 4 invariant explicitly forbids user-scoped telemetry rows
-- (T11 acceptance: "no user_id, IP, UA, or PII"). Joining install-id
-- with user-id would re-introduce the privacy hole. We trade per-user
-- attribution for the privacy guarantee — recorded in T11-review §2.
--
-- All statements are IF NOT EXISTS — runMigrations is idempotent and
-- safe under concurrent dashboard processes.

CREATE TABLE IF NOT EXISTS dashboard_meta (
  key        TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS telemetry_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id  TEXT NOT NULL CHECK (length(install_id) BETWEEN 8 AND 64),
  event_type  TEXT NOT NULL CHECK (event_type IN ('page_view', 'action_latency', 'feature_used')),
  event_name  TEXT NOT NULL CHECK (length(event_name) BETWEEN 1 AND 128),
  value_ms    INTEGER CHECK (value_ms IS NULL OR (value_ms >= 0 AND value_ms <= 600000)),
  created_at  INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_telemetry_events_created_at
  ON telemetry_events (created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_telemetry_events_event_type_name
  ON telemetry_events (event_type, event_name);
