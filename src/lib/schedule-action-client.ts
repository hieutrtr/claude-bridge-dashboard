// P3-T7 — pure browser helpers for the three schedule action mutations
// (`pause`, `resume`, `remove`). Mirrors `loop-mutation-client.ts` from
// P3-T4: a single typed factory builds the `RequestInit` for each
// action; a single envelope-decoder peels the tRPC response. No DOM
// imports, no React, no `document.cookie` access — the caller reads
// the CSRF token once and passes the string.
//
// Why a third client file: pause/resume/remove share their wire shape
// (`{ id }` → `{ ok: true }`), so collapsing them to one helper module
// keeps the matrix tight. We do NOT widen `loop-mutation-client.ts`
// to host schedule shapes — `loops.*` and `schedules.*` are sibling
// surfaces and a shared file would have to fan out the input types
// per-mutation anyway.

import { CSRF_HEADER } from "./csrf";

export type ScheduleAction = "pause" | "resume" | "remove";

export const SCHEDULE_ACTION_URL: Record<ScheduleAction, string> = {
  pause: "/api/trpc/schedules.pause",
  resume: "/api/trpc/schedules.resume",
  remove: "/api/trpc/schedules.remove",
};

export interface ScheduleActionInput {
  id: number;
}

export interface ScheduleActionResult {
  ok: true;
}

/** Typed error thrown by `parseTrpcResponse` for the error envelope. */
export class ScheduleActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ScheduleActionError";
    this.code = code;
  }
}

export function buildScheduleActionRequest(
  action: ScheduleAction,
  input: ScheduleActionInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return {
    url: SCHEDULE_ACTION_URL[action],
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify({ id: input.id }),
    },
  };
}

/**
 * Unwrap a tRPC v11 response envelope. Tolerates both the un-transformed
 * shape (`{result: {data: T}}`) and the json-wrapped shape
 * (`{result: {data: {json: T}}}`) so a future transformer flip doesn't
 * break the page. Throws `ScheduleActionError` on the error envelope.
 */
export function parseTrpcResponse<T>(value: unknown): T {
  if (value === null || typeof value !== "object") {
    throw new ScheduleActionError("INTERNAL_SERVER_ERROR", "malformed response");
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
    throw new ScheduleActionError(code, message);
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
  throw new ScheduleActionError("INTERNAL_SERVER_ERROR", "malformed response");
}
