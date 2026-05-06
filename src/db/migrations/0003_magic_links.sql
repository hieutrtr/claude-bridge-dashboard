-- P4-T01 — `magic_links` table (dashboard-owned).
--
-- Stores SHA-256 hashes of one-shot login tokens. The plaintext token
-- is generated as 32 random bytes (URL-safe base64), emailed to the
-- recipient, and never persisted server-side — only the hash is stored
-- so a database leak does not allow attackers to consume outstanding
-- tokens.
--
-- `consumed_at` is the single-use guard: the `auth.consumeMagicLink`
-- procedure executes
--     UPDATE magic_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL
-- inside one transaction; the row count tells the caller whether they
-- won the race or another tab beat them to it.
--
-- `expires_at` defaults to `created_at + 15min` (enforced in code, not
-- SQL — `DEFAULT (strftime(...))` evaluates differently across SQLite
-- versions and we already control the value at insert time).
--
-- `request_ip_hash` mirrors the `audit_log.ip_hash` shape so a single
-- forensic query can correlate request IPs across the magic-link
-- request → consume hop without persisting plaintext addresses.

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash      TEXT    PRIMARY KEY,
  email           TEXT    NOT NULL,
  email_lower     TEXT    GENERATED ALWAYS AS (lower(email)) STORED,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER,
  request_ip_hash TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_magic_links_expires_at ON magic_links (expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_magic_links_email_lower ON magic_links (email_lower);
