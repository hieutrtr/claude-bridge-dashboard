// P4-T11 — pure PII scrubber for telemetry event names + types.
//
// The Phase 4 invariant (T11 acceptance) forbids user-scoped or
// PII-laden telemetry rows. This module is the load-bearing sanitiser
// that every event passes through — once on the client (defence-in-
// depth) and once on the server (authoritative). Both call sites use
// the SAME helpers from this file so the test grid covers both.
//
// Scope:
//   * `sanitiseEventName`  — accept the route or feature key, strip
//     any embedded ID-like segment (UUID, hex, long digits) and
//     replace with `[id]`. Rejects strings that contain `@` (email),
//     query strings, and free-text > 128 chars.
//   * `sanitiseEventType`  — whitelist of three values; anything else
//     is rejected.
//   * `containsPii`        — best-effort detector used by tests + the
//     router validator. Looks for emails, IPv4 octets, hex tokens
//     >= 12 chars, query strings, and local-file paths. Returns the
//     reason string for telemetry rejection logging.
//   * `clampValueMs`       — coerces an action-latency duration into
//     [0, 600_000] (10 minutes). Anything outside the band is treated
//     as instrumentation drift and clamped silently.
//
// No DOM / no Node-only deps so the same module ships in both the
// browser recorder and the bun:sqlite-backed server router.

/** Whitelisted event types — anything else is rejected. */
export const TELEMETRY_EVENT_TYPES = [
  "page_view",
  "action_latency",
  "feature_used",
] as const;

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

const EVENT_NAME_MAX_LEN = 128;
const VALUE_MS_MAX = 600_000;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
const QUERY_RE = /[?&][^=]+=/;
const FILE_PATH_RE = /\/(home|Users|root|var|tmp|etc)\//;

// UUID v4-like (8-4-4-4-12) plus generic long hex tokens.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_TOKEN_RE = /\b[0-9a-f]{12,}\b/gi;
const LONG_DIGIT_RE = /\b\d{6,}\b/g;

export interface PiiReason {
  ok: false;
  reason:
    | "empty"
    | "too_long"
    | "email"
    | "ipv4"
    | "query_string"
    | "file_path"
    | "non_ascii";
}

export interface PiiOk {
  ok: true;
}

export type PiiCheck = PiiOk | PiiReason;

/**
 * Inspect an event-name string for PII patterns. Used by:
 *   * `sanitiseEventName` (rejects after the rewrite).
 *   * `tests/lib/telemetry-pii.test.ts` (fuzzes against the matrix).
 *   * `telemetry-router.ts` (last-mile guard before INSERT).
 */
export function containsPii(input: string): PiiCheck {
  if (typeof input !== "string") return { ok: false, reason: "empty" };
  if (input.length === 0) return { ok: false, reason: "empty" };
  if (input.length > EVENT_NAME_MAX_LEN) return { ok: false, reason: "too_long" };
  // Restrict to printable ASCII so we cannot smuggle PII as RTL marks
  // or emoji-disguised tokens. The dashboard's route names + feature
  // keys are all ASCII by construction.
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(input)) return { ok: false, reason: "non_ascii" };
  if (EMAIL_RE.test(input)) return { ok: false, reason: "email" };
  if (IPV4_RE.test(input)) return { ok: false, reason: "ipv4" };
  if (QUERY_RE.test(input)) return { ok: false, reason: "query_string" };
  if (FILE_PATH_RE.test(input)) return { ok: false, reason: "file_path" };
  return { ok: true };
}

/**
 * Rewrite an event-name string to its PII-stripped form.
 *
 *   `/tasks/123abc`                    → `/tasks/[id]`
 *   `/loops/01HZAR5DKXM9F0...`         → `/loops/[id]`
 *   `dispatch.success`                 → `dispatch.success`
 *
 * Returns null when the input still contains PII after rewrite (caller
 * should drop the event silently).
 */
export function sanitiseEventName(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.length === 0) return null;
  if (s.length > EVENT_NAME_MAX_LEN) s = s.slice(0, EVENT_NAME_MAX_LEN);
  // Order matters: UUID is a strict subset of HEX_TOKEN_RE, so run UUID
  // first. LONG_DIGIT_RE handles bare numeric IDs that escape both.
  s = s.replace(UUID_RE, "[id]");
  s = s.replace(HEX_TOKEN_RE, "[id]");
  s = s.replace(LONG_DIGIT_RE, "[id]");
  // Strip any query-string suffix entirely; never useful for telemetry.
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  s = s.trim();
  if (s.length === 0) return null;
  const check = containsPii(s);
  if (!check.ok) return null;
  return s;
}

/** Whitelist check on the event-type tag. */
export function sanitiseEventType(raw: unknown): TelemetryEventType | null {
  if (typeof raw !== "string") return null;
  for (const t of TELEMETRY_EVENT_TYPES) {
    if (t === raw) return t;
  }
  return null;
}

/**
 * Coerce an instrumentation duration to the [0, 600_000] ms band.
 * Negative / NaN / overflow values become null (recorder should drop
 * the field rather than write a bogus row).
 */
export function clampValueMs(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  if (n > VALUE_MS_MAX) return VALUE_MS_MAX;
  return Math.round(n);
}

export const TELEMETRY_LIMITS = Object.freeze({
  EVENT_NAME_MAX_LEN,
  VALUE_MS_MAX,
});
