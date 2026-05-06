// P2-T02 — browser-side helpers for the dispatch dialog. Pure: no DOM
// imports, no React, no `document.cookie` access here. The dialog reads
// `document.cookie` once and hands the string to `readCsrfTokenFromCookie`,
// and the helpers below just shape `RequestInit` + decode tRPC envelopes.
// This keeps the test surface a plain bun test (no jsdom) while letting
// the dialog wire the real DOM bits in one place.
//
// Wire format references:
//   - tRPC v11 fetch adapter w/o a transformer accepts the POST body as
//     the raw input object — `{<field>: <value>, ...}` — and returns
//     `{result: {data: <output>}}` for the success envelope and
//     `{error: {message, code, data: {...}}}` for the error envelope.
//     A `{json: <input>}` wrapper would have the server re-parse the
//     wrapper as the input itself; the dashboard does not run a
//     superjson transformer on either side.
//   - CSRF cookie name + header constants are shared with the server
//     (`src/server/csrf-guard.ts`) via `src/lib/csrf.ts` so the wire
//     contract stays single-sourced.

import { CSRF_COOKIE, CSRF_HEADER } from "./csrf";

export const DISPATCH_URL = "/api/trpc/tasks.dispatch";
export const AGENTS_LIST_URL = "/api/trpc/agents.list";

export interface DispatchInput {
  agentName: string;
  prompt: string;
  model?: string;
}

/** Typed error thrown by `parseTrpcResponse` for the error envelope. */
export class DispatchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
  }
}

/**
 * Pull the CSRF token out of a `Cookie` header / `document.cookie` string.
 * Returns null when the cookie is absent or the header is empty. Mirrors
 * the server-side parser in `src/server/csrf-guard.ts` (first match wins,
 * exact-name match — `bridge_csrf_tokenizer` does not collide with
 * `bridge_csrf_token`).
 */
export function readCsrfTokenFromCookie(
  cookieString: string | null | undefined,
): string | null {
  if (!cookieString) return null;
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== CSRF_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Build the `fetch` URL + RequestInit for `POST /api/trpc/tasks.dispatch`.
 * The dialog passes the result straight to `fetch(url, init)`.
 */
export function buildDispatchRequest(
  input: DispatchInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  const json: DispatchInput = {
    agentName: input.agentName,
    prompt: input.prompt,
  };
  if (input.model !== undefined) json.model = input.model;
  return {
    url: DISPATCH_URL,
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
 * Build the `fetch` URL + RequestInit for `GET /api/trpc/agents.list`.
 * Queries are exempt from CSRF (T08 guard skips safe methods); we do
 * not send the header so the request looks identical to the existing
 * server-side `appRouter.createCaller({}).agents.list()` call.
 */
export function buildAgentsListRequest(): { url: string; init: RequestInit } {
  return {
    url: AGENTS_LIST_URL,
    init: { method: "GET" },
  };
}

/**
 * Unwrap a tRPC v11 response envelope. Tolerates both the un-transformed
 * shape (`{result: {data: T}}`) and the json-wrapped shape
 * (`{result: {data: {json: T}}}`) so a future transformer flip doesn't
 * break the dialog. Throws `DispatchError` on the error envelope; the
 * dialog catches and surfaces `code` + `message`.
 */
export function parseTrpcResponse<T>(value: unknown): T {
  if (value === null || typeof value !== "object") {
    throw new DispatchError("INTERNAL_SERVER_ERROR", "malformed response");
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
    throw new DispatchError(code, message);
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
  throw new DispatchError("INTERNAL_SERVER_ERROR", "malformed response");
}
