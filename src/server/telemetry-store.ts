// P4-T11 — server-side telemetry store.
//
// Sandwiched between the tRPC router (`telemetry.record`) and the
// `telemetry_events` table. The router is responsible for RBAC + CSRF
// + audit; this module owns:
//   * the opt-in gate (no row inserted while toggle is OFF)
//   * the PII scrubber (`sanitiseEventName` + whitelist for type)
//   * the install-id binding (every row carries the install-scoped UUID,
//     never a user id)
//   * a recent-rows reader for the "View what we collect" panel.
//
// The `recordEvent` return shape matches what the UI/audit need:
//   `accepted`  — opt-in ON + sanitiser passed → row inserted, returns id.
//   `dropped_off` — opt-in OFF → no row, no error (silent no-op).
//   `dropped_pii` — opt-in ON + sanitiser rejected → no row, returns the
//                   rejection reason so the router can audit it (without
//                   echoing the offending string).

import { Database } from "bun:sqlite";

import { getSqlite } from "./db";
import {
  getOrCreateInstallId,
  getTelemetryOptIn,
} from "./dashboard-meta";
import {
  clampValueMs,
  containsPii,
  sanitiseEventName,
  sanitiseEventType,
  type TelemetryEventType,
} from "../lib/telemetry-pii";

export interface RecordEventInput {
  eventType: string;
  eventName: string;
  valueMs?: number | null;
  /** Override `Date.now()` — used by tests for stable `created_at`. */
  now?: number;
  db?: Database;
}

export type RecordEventResult =
  | {
      status: "accepted";
      id: number;
      eventType: TelemetryEventType;
      eventName: string;
      valueMs: number | null;
      installId: string;
    }
  | { status: "dropped_off" }
  | {
      status: "dropped_pii";
      reason:
        | "type"
        | "empty"
        | "too_long"
        | "email"
        | "ipv4"
        | "query_string"
        | "file_path"
        | "non_ascii";
    };

export function recordEvent(input: RecordEventInput): RecordEventResult {
  const handle = input.db ?? getSqlite();
  if (!getTelemetryOptIn(handle)) return { status: "dropped_off" };

  const eventType = sanitiseEventType(input.eventType);
  if (!eventType) return { status: "dropped_pii", reason: "type" };

  const sanitisedName = sanitiseEventName(input.eventName);
  if (!sanitisedName) {
    const probe = containsPii(
      typeof input.eventName === "string" ? input.eventName : "",
    );
    return {
      status: "dropped_pii",
      reason: probe.ok ? "empty" : probe.reason,
    };
  }

  const valueMs = clampValueMs(input.valueMs ?? null);
  const installId = getOrCreateInstallId(handle);
  const createdAt = input.now ?? Date.now();

  const row = handle
    .prepare(
      `INSERT INTO telemetry_events
        (install_id, event_type, event_name, value_ms, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(installId, eventType, sanitisedName, valueMs, createdAt) as
    | { id: number }
    | null;

  return {
    status: "accepted",
    id: row?.id ?? -1,
    eventType,
    eventName: sanitisedName,
    valueMs,
    installId,
  };
}

export interface RecentEvent {
  id: number;
  eventType: TelemetryEventType;
  eventName: string;
  valueMs: number | null;
  createdAt: number;
}

/** Return the most-recent N events (default 25) for the UI panel. */
export function listRecentEvents(
  limit: number = 25,
  db?: Database,
): RecentEvent[] {
  const handle = db ?? getSqlite();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = handle
    .prepare(
      `SELECT id, event_type, event_name, value_ms, created_at
         FROM telemetry_events
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(safeLimit) as Array<{
      id: number;
      event_type: TelemetryEventType;
      event_name: string;
      value_ms: number | null;
      created_at: number;
    }>;
  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    eventName: r.event_name,
    valueMs: r.value_ms,
    createdAt: r.created_at,
  }));
}

export interface TelemetryCounts {
  total: number;
  pageView: number;
  actionLatency: number;
  featureUsed: number;
}

export function countEvents(db?: Database): TelemetryCounts {
  const handle = db ?? getSqlite();
  const total = (
    handle
      .prepare(`SELECT count(*) AS n FROM telemetry_events`)
      .get() as { n: number } | null
  )?.n ?? 0;
  const byType = handle
    .prepare(
      `SELECT event_type, count(*) AS n
         FROM telemetry_events GROUP BY event_type`,
    )
    .all() as Array<{ event_type: TelemetryEventType; n: number }>;
  const counts: TelemetryCounts = {
    total,
    pageView: 0,
    actionLatency: 0,
    featureUsed: 0,
  };
  for (const row of byType) {
    if (row.event_type === "page_view") counts.pageView = row.n;
    else if (row.event_type === "action_latency") counts.actionLatency = row.n;
    else if (row.event_type === "feature_used") counts.featureUsed = row.n;
  }
  return counts;
}
