// P3-T8 — pure browser helper for the run-history drawer's tRPC query.
// Mirrors `schedule-action-client.ts` (P3-T7) — no DOM imports, no
// React. The drawer wraps this in a small fetch effect.
//
// Wire format reference:
//   - tRPC v11 fetch adapter encodes a query's input on the URL:
//     `GET /api/trpc/<proc>?input=<URL-encoded JSON>`. The default
//     (no transformer) jsonifier reads the value as the raw input —
//     no `{json: <input>}` wrapper.
//   - GET requests are exempt from CSRF (same as `agents.list` on
//     the dispatch dialog) — the guard short-circuits safe methods.
//
// `parseTrpcResponse` handles both the un-transformed envelope shape
// (`{result: {data: T}}`) and the json-wrapped shape (`{result: {data:
// {json: T}}}`) so a future transformer flip doesn't break the drawer.

import type { ScheduleRunsPage } from "../server/dto";

export const SCHEDULE_RUNS_URL = "/api/trpc/schedules.runs";

export interface ScheduleRunsInput {
  id: number;
  limit?: number;
}

/** Typed error thrown by `parseTrpcResponse` for the error envelope. */
export class ScheduleRunsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ScheduleRunsError";
    this.code = code;
  }
}

/**
 * Build the `fetch` URL + RequestInit for `GET /api/trpc/schedules.runs`.
 * `limit` is omitted from the encoded input when undefined so the
 * server applies the procedure default (30) — keeps the wire bytes
 * minimal on the most common call path.
 */
export function buildScheduleRunsRequest(
  input: ScheduleRunsInput,
): { url: string; init: RequestInit } {
  const json: ScheduleRunsInput =
    input.limit === undefined ? { id: input.id } : { id: input.id, limit: input.limit };
  const encoded = encodeURIComponent(JSON.stringify(json));
  return {
    url: `${SCHEDULE_RUNS_URL}?input=${encoded}`,
    init: { method: "GET" },
  };
}

export function parseTrpcResponse<T = ScheduleRunsPage>(value: unknown): T {
  if (value === null || typeof value !== "object") {
    throw new ScheduleRunsError("INTERNAL_SERVER_ERROR", "malformed response");
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
    throw new ScheduleRunsError(code, message);
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
  throw new ScheduleRunsError("INTERNAL_SERVER_ERROR", "malformed response");
}
