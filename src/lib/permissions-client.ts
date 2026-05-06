// P2-T09 — browser-side helpers for the permission relay toast.
// Pure: no DOM imports, no React, no `document.cookie` access here.
// Mirrors `src/lib/dispatch-client.ts` and `src/lib/danger-confirm-client.ts`.

import { CSRF_HEADER } from "./csrf";
export {
  parseTrpcResponse,
  readCsrfTokenFromCookie,
  DispatchError,
} from "./dispatch-client";

export const RESPOND_URL = "/api/trpc/permissions.respond";

export type PermissionDecision = "approved" | "denied";

export interface RespondInput {
  id: string;
  decision: PermissionDecision;
}

export interface RespondResult {
  ok: true;
  alreadyResolved: boolean;
}

export function buildRespondRequest(
  input: RespondInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return {
    url: RESPOND_URL,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify({ json: input }),
    },
  };
}
