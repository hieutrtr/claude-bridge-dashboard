// P3-T3 — browser-side helpers for the start-loop dialog. Pure: no
// DOM imports, no React, no `document.cookie` access here. The dialog
// reads `document.cookie` once and hands the string to
// `readCsrfTokenFromCookie`, and the helpers below shape `RequestInit`
// + decode tRPC envelopes. Same separation as
// `src/lib/dispatch-client.ts` — keeps the test surface a plain bun
// test (no jsdom) while the dialog wires the real DOM bits.
//
// Wire format references (mirrors dispatch-client.ts):
//   - tRPC v11 fetch adapter w/o a transformer accepts POST body as
//     `{json: <input>}` and returns `{result: {data: <output>}}` for
//     the success envelope and `{error: {message, code, data: {...}}}`
//     for the error envelope.
//   - CSRF cookie name + header constants come from `src/lib/csrf.ts`
//     so the wire contract stays single-sourced.
//
// Client-side `done_when` validation prefix matches the server-side
// regex in `src/server/routers/loops.ts` exactly. Re-exported so the
// dialog and any future surface use the same source of truth.

import { CSRF_HEADER } from "./csrf";

export const LOOP_START_URL = "/api/trpc/loops.start";

export interface LoopStartInput {
  agentName: string;
  goal: string;
  doneWhen: string;
  maxIterations?: number;
  maxCostUsd?: number;
  loopType?: "bridge" | "agent" | "auto";
  planFirst?: boolean;
  passThreshold?: number;
  channelChatId?: string;
}

export const DONE_WHEN_PRESETS: ReadonlyArray<{
  value: "command" | "file_exists" | "file_contains" | "llm_judge" | "manual";
  label: string;
  hint: string;
}> = [
  {
    value: "manual",
    label: "Manual approval",
    hint: "Loop pauses each iter waiting for human Approve / Deny.",
  },
  {
    value: "llm_judge",
    label: "LLM judge",
    hint: "Optional rubric; an LLM evaluates each iter and votes PASS/FAIL.",
  },
  {
    value: "command",
    label: "Shell command",
    hint: "e.g. `bun test` — exit code 0 ⇒ done.",
  },
  {
    value: "file_exists",
    label: "File exists",
    hint: "Absolute path; loop ends when the file appears.",
  },
  {
    value: "file_contains",
    label: "File contains",
    hint: "Path + substring; e.g. `README.md OK`.",
  },
];

/**
 * Compose a `done_when` string from the preset + the free-form value.
 * Pure for testability — the dialog reuses this on every keystroke so
 * the live preview matches exactly what the server will receive.
 *
 * `manual` is the only preset where the value is optional: an empty
 * value renders as `"manual:"` (the daemon's accepted form). For the
 * other prefixes, an empty value still produces a syntactically valid
 * — but semantically incomplete — composition. The dialog disables
 * submit when `value.trim()` is empty for non-manual prefixes; we
 * return the literal here so the rendered preview mirrors the server
 * input on each keystroke even before the form is valid.
 */
export function composeDoneWhen(
  prefix: "command" | "file_exists" | "file_contains" | "llm_judge" | "manual",
  value: string,
): string {
  if (prefix === "manual" && value.trim().length === 0) return "manual:";
  return `${prefix}: ${value.trim()}`;
}

/**
 * Validate a `done_when` composition against the server's regex.
 * Re-exposed client-side so the form can light up red borders before
 * the user clicks submit.
 */
const DONE_WHEN_PATTERN =
  /^(command|file_exists|file_contains|llm_judge|manual):.*$/;
export function isValidDoneWhen(value: string): boolean {
  if (value.length === 0 || value.length > 2_000) return false;
  return DONE_WHEN_PATTERN.test(value);
}

export class LoopStartError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LoopStartError";
    this.code = code;
  }
}

/**
 * Build the `fetch` URL + RequestInit for `POST /api/trpc/loops.start`.
 * Optional fields are dropped from the wire payload when undefined —
 * Zod's `.optional()` rejects an explicit `undefined` value as
 * structurally present, so we never include the key unless the dialog
 * has a real value for it.
 */
export function buildLoopStartRequest(
  input: LoopStartInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  const json: Record<string, unknown> = {
    agentName: input.agentName,
    goal: input.goal,
    doneWhen: input.doneWhen,
  };
  if (input.maxIterations !== undefined) json.maxIterations = input.maxIterations;
  if (input.maxCostUsd !== undefined) json.maxCostUsd = input.maxCostUsd;
  if (input.loopType !== undefined) json.loopType = input.loopType;
  if (input.planFirst !== undefined) json.planFirst = input.planFirst;
  if (input.passThreshold !== undefined) json.passThreshold = input.passThreshold;
  if (input.channelChatId !== undefined) json.channelChatId = input.channelChatId;
  return {
    url: LOOP_START_URL,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify({ json }),
    },
  };
}

/**
 * Unwrap a tRPC v11 response envelope. Tolerates both the un-transformed
 * shape (`{result: {data: T}}`) and the json-wrapped shape
 * (`{result: {data: {json: T}}}`) so a future transformer flip doesn't
 * break the dialog. Throws `LoopStartError` on the error envelope; the
 * dialog catches and surfaces `code` + `message`.
 */
export function parseTrpcResponse<T>(value: unknown): T {
  if (value === null || typeof value !== "object") {
    throw new LoopStartError("INTERNAL_SERVER_ERROR", "malformed response");
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
    throw new LoopStartError(code, message);
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
  throw new LoopStartError("INTERNAL_SERVER_ERROR", "malformed response");
}
