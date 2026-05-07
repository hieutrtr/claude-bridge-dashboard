// P4-T11 — `dashboard_meta` k/v helpers.
//
// Stores install-scoped settings that don't fit in `users` or
// `notification_preferences`. Currently used for the telemetry
// opt-in toggle + the install-id UUID. The table is one row per key,
// and lookups are rare (dashboard boot + telemetry record path) so we
// don't bother with caching — bun:sqlite calls are < 1ms locally.
//
// Keys live under the `meta_*` namespace by convention. Values are
// always TEXT — booleans round-trip as `"true"` | `"false"`.

import { Database } from "bun:sqlite";

import { getSqlite } from "./db";

const TELEMETRY_OPT_IN_KEY = "telemetry_opt_in";
const INSTALL_ID_KEY = "install_id";

interface MetaRow {
  key: string;
  value: string;
  updated_at: number;
}

export function getMeta(key: string, db?: Database): string | null {
  const handle = db ?? getSqlite();
  const row = handle
    .prepare(`SELECT key, value, updated_at FROM dashboard_meta WHERE key = ?`)
    .get(key) as MetaRow | null;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string, db?: Database): void {
  const handle = db ?? getSqlite();
  handle
    .prepare(
      `INSERT INTO dashboard_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Date.now());
}

export function getTelemetryOptIn(db?: Database): boolean {
  return getMeta(TELEMETRY_OPT_IN_KEY, db) === "true";
}

export function setTelemetryOptIn(enabled: boolean, db?: Database): void {
  setMeta(TELEMETRY_OPT_IN_KEY, enabled ? "true" : "false", db);
}

/**
 * Get the install-id UUID, generating one on first call. Stable for
 * the lifetime of the install (until `bridge.db` is wiped).
 */
export function getOrCreateInstallId(db?: Database): string {
  const handle = db ?? getSqlite();
  const existing = getMeta(INSTALL_ID_KEY, handle);
  if (existing && existing.length >= 8) return existing;
  const id = crypto.randomUUID();
  setMeta(INSTALL_ID_KEY, id, handle);
  return id;
}

export const DASHBOARD_META_KEYS = Object.freeze({
  TELEMETRY_OPT_IN: TELEMETRY_OPT_IN_KEY,
  INSTALL_ID: INSTALL_ID_KEY,
});
