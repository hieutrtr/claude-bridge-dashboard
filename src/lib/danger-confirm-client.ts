// P2-T11 — pure browser helpers for the danger-confirm dialog. No DOM,
// no React. Mirrors `src/lib/dispatch-client.ts` (T02) and reuses its
// CSRF-cookie reader and tRPC envelope unwrapper so every browser
// mutation goes through one toolbox.

import { CSRF_HEADER } from "./csrf";
import {
  DispatchError,
  parseTrpcResponse,
  readCsrfTokenFromCookie,
} from "./dispatch-client";

export const KILL_TASK_URL = "/api/trpc/tasks.kill";

export interface KillTaskInput {
  id: number;
}

export interface KillTaskResult {
  ok: true;
  alreadyTerminated: boolean;
}

export function buildKillTaskRequest(
  input: KillTaskInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return {
    url: KILL_TASK_URL,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify({ json: { id: input.id } }),
    },
  };
}

/**
 * Strict-equality match between the user's typed value and the expected
 * confirmation token. Trims whitespace (so a trailing newline from a
 * paste doesn't trip the user) but is case-sensitive — the agent name
 * `alpha` is not the same as `Alpha`. Empty `expected` always returns
 * false so a caller that forgets to pass the token never auto-passes.
 */
export function isConfirmationMatch(
  input: string,
  expected: string,
): boolean {
  const trimmed = input.trim();
  if (trimmed.length === 0 || expected.length === 0) return false;
  return trimmed === expected;
}

export { DispatchError, parseTrpcResponse, readCsrfTokenFromCookie };
