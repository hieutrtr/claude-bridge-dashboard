// P4-T11 — pure browser helpers for the telemetry.* mutations. No DOM
// imports / no React imports — the recorder must be importable from
// both server components (for SSR no-ops) and client components.
//
// Public surface:
//   * `buildSetOptInRequest`  — wraps `/api/trpc/telemetry.setOptIn`.
//   * `buildRecordRequest`    — wraps `/api/trpc/telemetry.record`.
//                               Sanitises the eventName client-side
//                               first so a trivially-broken instrumentation
//                               never even hits the wire.
//   * `parseTrpcResponse`     — re-export of the notifications-client
//                               envelope unwrapper (one shared parser).
//   * `TelemetryError`        — typed error subclass for failures.
//
// The router does its own sanitisation (defence-in-depth). Doing the
// rewrite here ALSO means tests that call `buildRecordRequest` directly
// see the post-scrub event name in the request body — much easier to
// assert on than diffing two strings every test.

import { CSRF_HEADER } from "./csrf";
import {
  parseTrpcResponse as parseEnv,
  NotificationsMutationError,
} from "./notifications-client";
import {
  TELEMETRY_EVENT_TYPES,
  clampValueMs,
  containsPii,
  sanitiseEventName,
  sanitiseEventType,
  type TelemetryEventType,
} from "./telemetry-pii";

export const TELEMETRY_SET_OPT_IN_URL = "/api/trpc/telemetry.setOptIn";
export const TELEMETRY_RECORD_URL = "/api/trpc/telemetry.record";

export interface SetOptInInput {
  enabled: boolean;
}

export interface SetOptInResult {
  enabled: boolean;
  installId: string | null;
  changed: boolean;
}

export interface OptInStatusResponse {
  enabled: boolean;
  installId: string | null;
  counts: {
    total: number;
    pageView: number;
    actionLatency: number;
    featureUsed: number;
  };
}

export interface RecordEventInput {
  eventType: TelemetryEventType;
  eventName: string;
  valueMs?: number | null;
}

export interface RecordEventResult {
  status: "accepted" | "dropped_off" | "dropped_pii";
  id: number | null;
  eventName: string | null;
  reason: string | null;
}

export class TelemetryError extends NotificationsMutationError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "TelemetryError";
  }
}

function jsonInit(body: unknown, csrfToken: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CSRF_HEADER]: csrfToken,
    },
    body: JSON.stringify(body),
  };
}

export function buildSetOptInRequest(
  input: SetOptInInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return { url: TELEMETRY_SET_OPT_IN_URL, init: jsonInit(input, csrfToken) };
}

export interface BuildRecordOk {
  ok: true;
  url: string;
  init: RequestInit;
  /** Post-scrub event name as it will be sent on the wire. */
  eventName: string;
}

export interface BuildRecordSkip {
  ok: false;
  reason:
    | "type"
    | "empty"
    | "too_long"
    | "email"
    | "ipv4"
    | "query_string"
    | "file_path"
    | "non_ascii";
}

/**
 * Build a `telemetry.record` request, returning `{ ok: false, reason }`
 * if the input would be rejected by the server-side scrubber. The
 * caller is expected to drop the event silently on a skip — the UI
 * never surfaces telemetry rejection errors to the user.
 */
export function buildRecordRequest(
  input: RecordEventInput,
  csrfToken: string,
): BuildRecordOk | BuildRecordSkip {
  const eventType = sanitiseEventType(input.eventType);
  if (!eventType) return { ok: false, reason: "type" };
  const sanitisedName = sanitiseEventName(input.eventName);
  if (!sanitisedName) {
    const probe = containsPii(
      typeof input.eventName === "string" ? input.eventName : "",
    );
    return { ok: false, reason: probe.ok ? "empty" : probe.reason };
  }
  const valueMs = clampValueMs(input.valueMs ?? null);
  return {
    ok: true,
    url: TELEMETRY_RECORD_URL,
    init: jsonInit(
      { eventType, eventName: sanitisedName, valueMs },
      csrfToken,
    ),
    eventName: sanitisedName,
  };
}

export const parseTrpcResponse = parseEnv;

/**
 * Convenience client-side recorder. NO-OPs (returns `null`) when:
 *   * not running in a browser
 *   * CSRF cookie missing
 *   * input rejected by the scrubber
 *
 * The opt-in gate lives on the server — this helper does NOT need to
 * know whether opt-in is enabled. The server returns `dropped_off`
 * when it isn't, which the helper surfaces in the result for callers
 * that want to react.
 */
export async function recordTelemetry(
  input: RecordEventInput,
  csrfToken: string | null,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<RecordEventResult | null> {
  if (csrfToken === null) return null;
  const built = buildRecordRequest(input, csrfToken);
  if (!built.ok) return null;
  const f = opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
  if (!f) return null;
  const res = await f(built.url, built.init);
  const data = (await res.json()) as unknown;
  return parseTrpcResponse<RecordEventResult>(data);
}

export const TELEMETRY_EVENT_TYPE_VALUES = TELEMETRY_EVENT_TYPES;
