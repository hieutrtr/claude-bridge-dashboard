// P4-T02 — `src/lib/users-client.ts` browser helpers.

import { describe, it, expect } from "bun:test";

import {
  buildChangeRoleRequest,
  buildInviteRequest,
  buildRevokeRequest,
  isValidEmail,
  parseTrpcResponse,
  USERS_CHANGE_ROLE_URL,
  USERS_INVITE_URL,
  USERS_REVOKE_URL,
  UsersMutationError,
  type UsersMutationResult,
} from "../../src/lib/users-client";
import { CSRF_HEADER } from "../../src/lib/csrf";

describe("buildInviteRequest", () => {
  it("emits a POST to the invite URL with CSRF + JSON body", () => {
    const { url, init } = buildInviteRequest(
      { email: "x@example.com", role: "member" },
      "csrf-token",
    );
    expect(url).toBe(USERS_INVITE_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe("csrf-token");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "x@example.com",
      role: "member",
    });
  });
});

describe("buildRevokeRequest", () => {
  it("emits a POST with the user id", () => {
    const { url, init } = buildRevokeRequest(
      { id: "u-1" },
      "csrf",
    );
    expect(url).toBe(USERS_REVOKE_URL);
    expect(JSON.parse(init.body as string)).toEqual({ id: "u-1" });
  });
});

describe("buildChangeRoleRequest", () => {
  it("emits a POST with id + role", () => {
    const { url, init } = buildChangeRoleRequest(
      { id: "u-1", role: "owner" },
      "csrf",
    );
    expect(url).toBe(USERS_CHANGE_ROLE_URL);
    expect(JSON.parse(init.body as string)).toEqual({
      id: "u-1",
      role: "owner",
    });
  });
});

describe("parseTrpcResponse", () => {
  it("unwraps `{result: {data: T}}`", () => {
    const out = parseTrpcResponse<UsersMutationResult>({
      result: { data: { ok: true, alreadyExisted: true } },
    });
    expect(out).toEqual({ ok: true, alreadyExisted: true });
  });

  it("unwraps `{result: {data: {json: T}}}` (transformer-wrapped)", () => {
    const out = parseTrpcResponse<UsersMutationResult>({
      result: { data: { json: { ok: true } } },
    });
    expect(out).toEqual({ ok: true });
  });

  it("throws UsersMutationError with code + message on the error envelope", () => {
    expect(() =>
      parseTrpcResponse({
        error: {
          message: "owner role required",
          data: { code: "FORBIDDEN" },
        },
      }),
    ).toThrow(UsersMutationError);
  });

  it("falls back to INTERNAL_SERVER_ERROR for malformed shapes", () => {
    expect(() => parseTrpcResponse(null)).toThrow(UsersMutationError);
    expect(() => parseTrpcResponse({ random: 1 })).toThrow(UsersMutationError);
  });
});

describe("isValidEmail", () => {
  it.each([
    ["a@b.co", true],
    ["alice+tag@example.com", true],
    ["", false],
    ["plain", false],
    ["a@b", false],
    ["@example.com", false],
    ["missing@.com", false],
  ])("isValidEmail(%j) = %j", (input, expected) => {
    expect(isValidEmail(input)).toBe(expected);
  });

  it("rejects > 320 chars", () => {
    const huge = `${"a".repeat(320)}@x.co`;
    expect(isValidEmail(huge)).toBe(false);
  });
});
