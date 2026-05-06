// P3-T4 — browser-side helpers for the three loop-detail-page
// mutations (cancel, approve, reject). Pure: no DOM imports, no React,
// no `document.cookie` access. The component reads `document.cookie`
// once and hands the string to `readCsrfTokenFromCookie`; the helpers
// shape `RequestInit` + decode tRPC envelopes. Mirrors the layered
// shape of `src/lib/dispatch-client.ts` (T02) and
// `src/lib/danger-confirm-client.ts` (T11) so every browser mutation
// goes through one toolbox.
//
// Why a third file (vs piggy-backing on `loop-start-client`): the
// start-loop dialog is a creation surface — the response carries a
// `loopId`. Cancel / approve / reject are server-confirmed gate
// actions returning `{ ok, alreadyFinalized }`. Keeping the wire
// shapes in their own file avoids the temptation to widen
// `LoopStartResult` into a union, and the test matrix stays tight.

import { CSRF_HEADER } from "./csrf";

export const LOOP_CANCEL_URL = "/api/trpc/loops.cancel";
export const LOOP_APPROVE_URL = "/api/trpc/loops.approve";
export const LOOP_REJECT_URL = "/api/trpc/loops.reject";

export interface LoopGateInput {
  loopId: string;
}

export interface LoopRejectInput extends LoopGateInput {
  reason?: string;
}

export interface LoopGateResult {
  ok: true;
  alreadyFinalized: boolean;
}

/** Typed error thrown by `parseTrpcResponse` for the error envelope. */
export class LoopMutationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LoopMutationError";
    this.code = code;
  }
}

function buildPost(
  url: string,
  payload: Record<string, unknown>,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return {
    url,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify(payload),
    },
  };
}

export function buildLoopCancelRequest(
  input: LoopGateInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return buildPost(LOOP_CANCEL_URL, { loopId: input.loopId }, csrfToken);
}

export function buildLoopApproveRequest(
  input: LoopGateInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return buildPost(LOOP_APPROVE_URL, { loopId: input.loopId }, csrfToken);
}

export function buildLoopRejectRequest(
  input: LoopRejectInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  const payload: Record<string, unknown> = { loopId: input.loopId };
  if (input.reason !== undefined) payload.reason = input.reason;
  return buildPost(LOOP_REJECT_URL, payload, csrfToken);
}

/**
 * Unwrap a tRPC v11 response envelope. Tolerates both the un-transformed
 * shape (`{result: {data: T}}`) and the json-wrapped shape
 * (`{result: {data: {json: T}}}`) so a future transformer flip doesn't
 * break the page. Throws `LoopMutationError` on the error envelope.
 */
export function parseTrpcResponse<T>(value: unknown): T {
  if (value === null || typeof value !== "object") {
    throw new LoopMutationError("INTERNAL_SERVER_ERROR", "malformed response");
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
    throw new LoopMutationError(code, message);
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
  throw new LoopMutationError("INTERNAL_SERVER_ERROR", "malformed response");
}
