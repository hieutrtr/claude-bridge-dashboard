// P3-T6 — browser-side helpers for the schedule-create dialog. Pure:
// no DOM imports, no React, no `document.cookie` access here. The
// dialog reads `document.cookie` once and hands the string to
// `readCsrfTokenFromCookie`, and the helpers below shape `RequestInit`
// + decode tRPC envelopes + own the cron picker preset table +
// cron→interval conversion. Same separation as
// `src/lib/loop-start-client.ts` — keeps the test surface a plain bun
// test (no jsdom) while the dialog wires the real DOM bits.
//
// Wire format references (mirrors loop-start-client.ts):
//   - tRPC v11 fetch adapter w/o a transformer accepts the POST body
//     as the raw input object and returns `{result: {data: <output>}}`
//     for the success envelope and `{error: {message, code, data: {...}}}`
//     for the error envelope.
//   - CSRF cookie name + header constants come from `src/lib/csrf.ts`
//     so the wire contract stays single-sourced.
//
// Cron daemon-side gap: the daemon's `bridge_schedule_add` MCP tool
// only accepts `interval_minutes` today (per
// `claude-bridge/src/mcp/tools.ts:285`). The cron picker converts the
// chosen expression to interval-minutes via `cron-parser` before
// submit, and rejects expressions whose fire-time deltas are
// non-uniform (e.g. `0 9 * * 1-5` weekdays — three 24h gaps then a
// 72h weekend gap). When daemon-side cron support lands, the dialog
// flips to forwarding `cronExpr` directly with no UI change.

import { CronExpressionParser } from "cron-parser";

import { CSRF_HEADER } from "./csrf";

export const SCHEDULE_ADD_URL = "/api/trpc/schedules.add";
export const SCHEDULE_COST_FORECAST_URL = "/api/trpc/schedules.costForecast";

export interface ScheduleAddInput {
  name?: string;
  agentName: string;
  prompt: string;
  intervalMinutes: number;
  cronExpr?: string;
  channelChatId?: string;
}

/** Typed error thrown by `parseTrpcResponse` for the error envelope. */
export class ScheduleAddError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ScheduleAddError";
    this.code = code;
  }
}

/**
 * Cron picker presets — three common cadences plus the "Custom" mode.
 * Each preset's `intervalMinutes` is hard-coded (computed once and
 * baked in) so the dialog renders without spawning a `cron-parser` on
 * every keystroke for the 99% case. The "Custom" preset has no
 * cronExpr / no intervalMinutes — the user types their own and the
 * dialog routes through `cronToIntervalMinutes` for validation.
 */
export const CRON_PRESETS: ReadonlyArray<{
  value: "hourly" | "daily-9am" | "weekly-mon-9am" | "custom";
  label: string;
  cronExpr: string | null;
  intervalMinutes: number | null;
}> = [
  {
    value: "hourly",
    label: "Every hour",
    cronExpr: "0 * * * *",
    intervalMinutes: 60,
  },
  {
    value: "daily-9am",
    label: "Daily at 09:00",
    cronExpr: "0 9 * * *",
    intervalMinutes: 24 * 60,
  },
  {
    value: "weekly-mon-9am",
    label: "Weekly Mon at 09:00",
    cronExpr: "0 9 * * 1",
    intervalMinutes: 7 * 24 * 60,
  },
  { value: "custom", label: "Custom", cronExpr: null, intervalMinutes: null },
];

const ONE_MINUTE_MS = 60_000;
const NEXT_FIRES_PREVIEW_COUNT = 3;

export interface CronEvalResult {
  /** Raw cron expression as the user typed it (trimmed). */
  cronExpr: string;
  /** Computed interval if the cron fires uniformly; null otherwise. */
  intervalMinutes: number | null;
  /**
   * `null` = parse error (cron itself invalid).
   * `"non-uniform"` = parses cleanly but next-3 deltas aren't equal —
   *   daemon can't model this today.
   * `"ok"` = uniform interval; submit-ready.
   */
  status: "ok" | "non-uniform" | null;
  /** Human-readable error / warning message (null when status="ok"). */
  message: string | null;
  /** Next N fire times computed from `now` (empty when status=null). */
  nextFires: Date[];
}

/**
 * Evaluate a cron expression against a given `now`. Returns:
 *   - parse failure → status=null, message="invalid cron expression"
 *   - parses but non-uniform deltas → status="non-uniform", interval=null
 *   - uniform deltas → status="ok", interval=<positive int minutes>
 *
 * Pure: tests pass `now` deterministically; production code passes
 * `new Date()`.
 */
export function evaluateCron(expr: string, now: Date): CronEvalResult {
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    return {
      cronExpr: trimmed,
      intervalMinutes: null,
      status: null,
      message: "Empty cron expression.",
      nextFires: [],
    };
  }
  let it: ReturnType<typeof CronExpressionParser.parse>;
  try {
    it = CronExpressionParser.parse(trimmed, { currentDate: now });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid cron expression";
    return {
      cronExpr: trimmed,
      intervalMinutes: null,
      status: null,
      message: msg,
      nextFires: [],
    };
  }
  // Pull next 4 fire times → 3 deltas.
  const fires: Date[] = [];
  try {
    for (let i = 0; i < NEXT_FIRES_PREVIEW_COUNT + 1; i++) {
      fires.push(it.next().toDate());
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "cron iterator exhausted";
    return {
      cronExpr: trimmed,
      intervalMinutes: null,
      status: null,
      message: msg,
      nextFires: fires,
    };
  }
  const deltas: number[] = [];
  for (let i = 1; i < fires.length; i++) {
    deltas.push(fires[i]!.getTime() - fires[i - 1]!.getTime());
  }
  const allEqual = deltas.every((d) => d === deltas[0]);
  if (!allEqual) {
    return {
      cronExpr: trimmed,
      intervalMinutes: null,
      status: "non-uniform",
      message:
        "Daemon only accepts uniform-interval schedules today (cron-parser found non-uniform deltas).",
      nextFires: fires.slice(0, NEXT_FIRES_PREVIEW_COUNT),
    };
  }
  const deltaMs = deltas[0]!;
  if (deltaMs <= 0 || deltaMs % ONE_MINUTE_MS !== 0) {
    return {
      cronExpr: trimmed,
      intervalMinutes: null,
      status: "non-uniform",
      message:
        "Cron expression resolves to a sub-minute or non-integer interval — daemon requires integer minutes.",
      nextFires: fires.slice(0, NEXT_FIRES_PREVIEW_COUNT),
    };
  }
  const intervalMinutes = deltaMs / ONE_MINUTE_MS;
  return {
    cronExpr: trimmed,
    intervalMinutes,
    status: "ok",
    message: null,
    nextFires: fires.slice(0, NEXT_FIRES_PREVIEW_COUNT),
  };
}

/**
 * Convenience: extract interval-minutes from a cron expression, or
 * `null` if the cron itself is invalid OR the deltas aren't uniform.
 * Same semantics as `evaluateCron(...).intervalMinutes` but discards
 * the diagnostic message; useful for tests asserting the conversion
 * shape.
 */
export function cronToIntervalMinutes(expr: string, now: Date): number | null {
  return evaluateCron(expr, now).intervalMinutes;
}

/**
 * Build the `fetch` URL + RequestInit for `POST /api/trpc/schedules.add`.
 * Optional fields are dropped from the wire payload when undefined —
 * Zod's `.optional()` rejects an explicit `undefined` value as
 * structurally present, so we never include the key unless the dialog
 * has a real value for it.
 */
export function buildScheduleAddRequest(
  input: ScheduleAddInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  const json: Record<string, unknown> = {
    agentName: input.agentName,
    prompt: input.prompt,
    intervalMinutes: input.intervalMinutes,
  };
  if (input.name !== undefined) json.name = input.name;
  if (input.cronExpr !== undefined) json.cronExpr = input.cronExpr;
  if (input.channelChatId !== undefined) json.channelChatId = input.channelChatId;
  return {
    url: SCHEDULE_ADD_URL,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify(json),
    },
  };
}

/**
 * P3-T9 — build the GET URL for a `schedules.costForecast` query. tRPC
 * v11 GET shape is `?input=<urlEncodedJsonEnvelope>` for un-transformed
 * inputs. Optional fields (intervalMinutes / cronExpr) are dropped
 * from the envelope when undefined, mirroring the POST builder above.
 */
export interface CostForecastFetchInput {
  agent: string;
  intervalMinutes?: number;
  cronExpr?: string;
}

export function buildCostForecastRequest(
  input: CostForecastFetchInput,
): { url: string; init: RequestInit } {
  const json: Record<string, unknown> = { agent: input.agent };
  if (input.intervalMinutes !== undefined) {
    json.intervalMinutes = input.intervalMinutes;
  }
  if (input.cronExpr !== undefined) {
    json.cronExpr = input.cronExpr;
  }
  const search = new URLSearchParams({ input: JSON.stringify(json) });
  return {
    url: `${SCHEDULE_COST_FORECAST_URL}?${search.toString()}`,
    init: { method: "GET" },
  };
}

/**
 * Unwrap a tRPC v11 response envelope. Tolerates both the un-transformed
 * shape (`{result: {data: T}}`) and the json-wrapped shape
 * (`{result: {data: {json: T}}}`) so a future transformer flip doesn't
 * break the dialog. Throws `ScheduleAddError` on the error envelope; the
 * dialog catches and surfaces `code` + `message`.
 */
export function parseTrpcResponse<T>(value: unknown): T {
  if (value === null || typeof value !== "object") {
    throw new ScheduleAddError("INTERNAL_SERVER_ERROR", "malformed response");
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
    throw new ScheduleAddError(code, message);
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
  throw new ScheduleAddError("INTERNAL_SERVER_ERROR", "malformed response");
}
