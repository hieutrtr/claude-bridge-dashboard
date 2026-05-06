// P4-T02 — pure browser helpers for the users.* mutations
// (`invite`, `revoke`, `changeRole`). Mirrors `schedule-action-client.ts`
// shape: builds `RequestInit` per call, parses the tRPC response
// envelope, throws a typed error. No React / DOM imports.

import { CSRF_HEADER } from "./csrf";

export const USERS_INVITE_URL = "/api/trpc/users.invite";
export const USERS_REVOKE_URL = "/api/trpc/users.revoke";
export const USERS_CHANGE_ROLE_URL = "/api/trpc/users.changeRole";

export interface UsersInviteInput {
  email: string;
  role: "owner" | "member";
}

export interface UsersRevokeInput {
  id: string;
}

export interface UsersChangeRoleInput {
  id: string;
  role: "owner" | "member";
}

export interface UsersMutationResult {
  ok: true;
  reactivated?: boolean;
  alreadyExisted?: boolean;
  alreadyApplied?: boolean;
}

export class UsersMutationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UsersMutationError";
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

export function buildInviteRequest(
  input: UsersInviteInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return {
    url: USERS_INVITE_URL,
    init: jsonInit(input, csrfToken),
  };
}

export function buildRevokeRequest(
  input: UsersRevokeInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return {
    url: USERS_REVOKE_URL,
    init: jsonInit(input, csrfToken),
  };
}

export function buildChangeRoleRequest(
  input: UsersChangeRoleInput,
  csrfToken: string,
): { url: string; init: RequestInit } {
  return {
    url: USERS_CHANGE_ROLE_URL,
    init: jsonInit(input, csrfToken),
  };
}

/**
 * Unwrap a tRPC v11 response envelope. Tolerates both the un-
 * transformed (`{result: {data: T}}`) and the json-wrapped
 * (`{result: {data: {json: T}}}`) shapes. Throws `UsersMutationError`
 * on the error envelope.
 */
export function parseTrpcResponse<T>(value: unknown): T {
  if (value === null || typeof value !== "object") {
    throw new UsersMutationError(
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
    throw new UsersMutationError(code, message);
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
  throw new UsersMutationError(
    "INTERNAL_SERVER_ERROR",
    "malformed response",
  );
}

export function isValidEmail(email: string): boolean {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length < 3 || trimmed.length > 320) return false;
  // Lightweight check — matches the server's z.string().email() floor.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}
