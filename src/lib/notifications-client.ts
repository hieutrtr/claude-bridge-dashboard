// P4-T06 — pure browser helpers for the notifications.* mutations
// (`update`, `reset`). Mirrors `users-client.ts`: build `RequestInit`
// per call, parse the tRPC envelope, throw a typed error. No React /
// DOM imports.

import { CSRF_HEADER } from "./csrf";

export const NOTIFICATIONS_UPDATE_URL = "/api/trpc/notifications.update";
export const NOTIFICATIONS_RESET_URL = "/api/trpc/notifications.reset";

export interface NotificationsUpdateInput {
  inAppEnabled?: boolean;
  emailDigestEnabled?: boolean;
  emailDigestHour?: number;
  emailDigestTz?: string;
  browserPushEnabled?: boolean;
}

export interface NotificationsPrefsResponse {
  inAppEnabled: boolean;
  emailDigestEnabled: boolean;
  emailDigestHour: number;
  emailDigestTz: string;
  browserPushEnabled: boolean;
  updatedAt: number;
}

export interface NotificationsMutationResult {
  ok: true;
  prefs: NotificationsPrefsResponse;
  changedKeys: ReadonlyArray<
    | "inAppEnabled"
    | "emailDigestEnabled"
    | "emailDigestHour"
    | "emailDigestTz"
    | "browserPushEnabled"
  >;
}

export class NotificationsMutationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NotificationsMutationError";
    this.code = code;
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

export function buildUpdateRequest(
  input: NotificationsUpdateInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return {
    url: NOTIFICATIONS_UPDATE_URL,
    init: jsonInit(input, csrfToken),
  };
}

export function buildResetRequest(csrfToken: string): {
  url: string;
  init: RequestInit;
} {
  return {
    url: NOTIFICATIONS_RESET_URL,
    init: jsonInit({}, csrfToken),
  };
}

/**
 * Unwrap a tRPC v11 response envelope. Tolerates both
 * `{result: {data: T}}` and `{result: {data: {json: T}}}` shapes.
 * Throws `NotificationsMutationError` on the error envelope.
 */
export function parseTrpcResponse<T>(value: unknown): T {
  if (value === null || typeof value !== "object") {
    throw new NotificationsMutationError(
      "INTERNAL_SERVER_ERROR",
      "malformed response",
    );
  }
  const obj = value as Record<string, unknown>;
  if ("error" in obj && obj.error !== null && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    const dataObj = (err.data ?? null) as Record<string, unknown> | null;
    const code =
      typeof dataObj?.code === "string" ? dataObj.code : "INTERNAL_SERVER_ERROR";
    const message =
      typeof err.message === "string" && err.message.length > 0
        ? err.message
        : "request failed";
    throw new NotificationsMutationError(code, message);
  }
  if ("result" in obj && obj.result !== null && typeof obj.result === "object") {
    const result = obj.result as Record<string, unknown>;
    const data = result.data;
    if (
      data !== null &&
      typeof data === "object" &&
      "json" in (data as Record<string, unknown>)
    ) {
      return (data as Record<string, unknown>).json as T;
    }
    return data as T;
  }
  throw new NotificationsMutationError(
    "INTERNAL_SERVER_ERROR",
    "malformed response",
  );
}

export const HOURS: ReadonlyArray<number> = Array.from(
  { length: 24 },
  (_, i) => i,
);

export function formatHour(hour: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return "--:--";
  return `${String(hour).padStart(2, "0")}:00`;
}

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string") return false;
  if (tz.length === 0 || tz.length > 64) return false;
  return /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz);
}

/**
 * Diff two prefs objects and return the changed key list. Used by
 * the UI to render an "X changes saved" toast. Mirrors the server-side
 * change detection.
 */
export function diffPrefs(
  before: NotificationsPrefsResponse,
  after: NotificationsPrefsResponse,
): ReadonlyArray<keyof Omit<NotificationsPrefsResponse, "updatedAt">> {
  const keys: Array<keyof Omit<NotificationsPrefsResponse, "updatedAt">> = [
    "inAppEnabled",
    "emailDigestEnabled",
    "emailDigestHour",
    "emailDigestTz",
    "browserPushEnabled",
  ];
  return keys.filter((k) => before[k] !== after[k]);
}
