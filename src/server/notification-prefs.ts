// P4-T06 — `notification_preferences` row helpers.
//
// Owns the SQL surface for reading/writing the toggle matrix. Used
// by `notifications.*` router (self-update) and the email-digest job
// (cross-user batch read). Splitting helpers from the router keeps
// the router thin and lets the digest job re-use the read path
// without spinning a tRPC caller.
//
// Read-on-miss pattern: callers ask for `findOrCreatePreferences(userId)`
// and always get a row back. The first call inserts defaults; future
// calls read the persisted row. This matches the migration default
// matrix exactly (in_app=1, email_digest=0, hour=9, tz=UTC, push=0).
//
// Privacy: this module never touches the email plaintext — `user_id`
// is the only join key. The digest job joins to `users` separately
// when it needs the destination address.

import { Database } from "bun:sqlite";

import { getSqlite } from "./db";

export interface NotificationPreferences {
  userId: string;
  inAppEnabled: boolean;
  emailDigestEnabled: boolean;
  /** 0..23, local-TZ hour at which the daily digest fires. */
  emailDigestHour: number;
  /** IANA TZ string. Defaults to "UTC". */
  emailDigestTz: string;
  /** Stub flag — UI records the bool, push delivery ships in v0.2.0. */
  browserPushEnabled: boolean;
  updatedAt: number;
}

interface RawRow {
  user_id: string;
  in_app_enabled: number;
  email_digest_enabled: number;
  email_digest_hour: number;
  email_digest_tz: string;
  browser_push_enabled: number;
  updated_at: number;
}

function fromRaw(raw: RawRow): NotificationPreferences {
  return {
    userId: raw.user_id,
    inAppEnabled: raw.in_app_enabled !== 0,
    emailDigestEnabled: raw.email_digest_enabled !== 0,
    emailDigestHour: raw.email_digest_hour,
    emailDigestTz: raw.email_digest_tz,
    browserPushEnabled: raw.browser_push_enabled !== 0,
    updatedAt: raw.updated_at,
  };
}

export const DEFAULT_PREFS = {
  inAppEnabled: true,
  emailDigestEnabled: false,
  emailDigestHour: 9,
  emailDigestTz: "UTC",
  browserPushEnabled: false,
} as const;

export function findPreferences(
  userId: string,
  db?: Database,
): NotificationPreferences | null {
  const handle = db ?? getSqlite();
  const row = handle
    .prepare(
      `SELECT user_id, in_app_enabled, email_digest_enabled,
              email_digest_hour, email_digest_tz,
              browser_push_enabled, updated_at
         FROM notification_preferences WHERE user_id = ?`,
    )
    .get(userId) as RawRow | null;
  return row ? fromRaw(row) : null;
}

export function findOrCreatePreferences(
  userId: string,
  db?: Database,
): NotificationPreferences {
  const handle = db ?? getSqlite();
  const existing = findPreferences(userId, handle);
  if (existing) return existing;
  const now = Date.now();
  // INSERT OR IGNORE so a concurrent first-read does not 19-CONSTRAINT.
  handle
    .prepare(
      `INSERT OR IGNORE INTO notification_preferences
        (user_id, in_app_enabled, email_digest_enabled,
         email_digest_hour, email_digest_tz,
         browser_push_enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      DEFAULT_PREFS.inAppEnabled ? 1 : 0,
      DEFAULT_PREFS.emailDigestEnabled ? 1 : 0,
      DEFAULT_PREFS.emailDigestHour,
      DEFAULT_PREFS.emailDigestTz,
      DEFAULT_PREFS.browserPushEnabled ? 1 : 0,
      now,
    );
  // Read-back guarantees the canonical row even on the lost-race side.
  const out = findPreferences(userId, handle);
  if (!out) {
    throw new Error(
      `notification-prefs: failed to create row for user ${userId}`,
    );
  }
  return out;
}

export interface UpdatePreferencesInput {
  userId: string;
  inAppEnabled?: boolean;
  emailDigestEnabled?: boolean;
  emailDigestHour?: number;
  emailDigestTz?: string;
  browserPushEnabled?: boolean;
  /** Override `Date.now()` — used by tests for stable `updated_at`. */
  now?: number;
  db?: Database;
}

export interface UpdatePreferencesResult {
  prefs: NotificationPreferences;
  /** Field keys that changed value compared to the prior row. */
  changedKeys: ReadonlyArray<
    | "inAppEnabled"
    | "emailDigestEnabled"
    | "emailDigestHour"
    | "emailDigestTz"
    | "browserPushEnabled"
  >;
}

const KEY_TO_COLUMN: Record<
  Exclude<keyof UpdatePreferencesInput, "userId" | "now" | "db">,
  string
> = {
  inAppEnabled: "in_app_enabled",
  emailDigestEnabled: "email_digest_enabled",
  emailDigestHour: "email_digest_hour",
  emailDigestTz: "email_digest_tz",
  browserPushEnabled: "browser_push_enabled",
};

export function updatePreferences(
  input: UpdatePreferencesInput,
): UpdatePreferencesResult {
  const handle = input.db ?? getSqlite();
  const now = input.now ?? Date.now();
  const before = findOrCreatePreferences(input.userId, handle);

  const sets: string[] = [];
  const values: Array<number | string> = [];
  const changedKeys: UpdatePreferencesResult["changedKeys"][number][] = [];

  function maybeBool(
    key: "inAppEnabled" | "emailDigestEnabled" | "browserPushEnabled",
  ): void {
    const next = input[key];
    if (next === undefined) return;
    if (next === before[key]) return;
    sets.push(`${KEY_TO_COLUMN[key]} = ?`);
    values.push(next ? 1 : 0);
    changedKeys.push(key);
  }

  maybeBool("inAppEnabled");
  maybeBool("emailDigestEnabled");
  maybeBool("browserPushEnabled");

  if (input.emailDigestHour !== undefined) {
    if (input.emailDigestHour !== before.emailDigestHour) {
      sets.push("email_digest_hour = ?");
      values.push(input.emailDigestHour);
      changedKeys.push("emailDigestHour");
    }
  }
  if (input.emailDigestTz !== undefined) {
    if (input.emailDigestTz !== before.emailDigestTz) {
      sets.push("email_digest_tz = ?");
      values.push(input.emailDigestTz);
      changedKeys.push("emailDigestTz");
    }
  }

  if (sets.length === 0) {
    return { prefs: before, changedKeys: [] };
  }

  sets.push("updated_at = ?");
  values.push(now);
  values.push(input.userId);

  handle
    .prepare(
      `UPDATE notification_preferences SET ${sets.join(", ")} WHERE user_id = ?`,
    )
    .run(...values);

  const after = findPreferences(input.userId, handle);
  if (!after) {
    throw new Error(
      `notification-prefs: row vanished mid-update for user ${input.userId}`,
    );
  }
  return { prefs: after, changedKeys };
}

export interface DigestRecipient {
  userId: string;
  email: string;
  hour: number;
  tz: string;
}

/**
 * Read all active users with `email_digest_enabled = 1`. The digest
 * job pairs this with a per-user 24h task summary and sends one email
 * per matching `hour`.
 *
 * "Active" = `users.revoked_at IS NULL`. Revoked users keep their
 * prefs row but are filtered out here so the digest job never emails
 * a deactivated address.
 */
export function listEmailDigestRecipients(
  db?: Database,
): DigestRecipient[] {
  const handle = db ?? getSqlite();
  const rows = handle
    .prepare(
      `SELECT u.id          AS user_id,
              u.email       AS email,
              p.email_digest_hour AS hour,
              p.email_digest_tz   AS tz
         FROM notification_preferences p
         JOIN users u ON u.id = p.user_id
        WHERE p.email_digest_enabled = 1
          AND u.revoked_at IS NULL
        ORDER BY u.id ASC`,
    )
    .all() as Array<{
      user_id: string;
      email: string;
      hour: number;
      tz: string;
    }>;
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    hour: r.hour,
    tz: r.tz,
  }));
}
