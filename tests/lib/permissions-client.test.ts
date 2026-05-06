// P2-T09 — pure browser helpers for the permission relay toast. No
// DOM, no React; same shape as `tests/lib/dispatch-client.test.ts`.

import { describe, it, expect } from "bun:test";

import { CSRF_HEADER } from "../../src/lib/csrf";
import {
  RESPOND_URL,
  buildRespondRequest,
} from "../../src/lib/permissions-client";

describe("buildRespondRequest", () => {
  it("targets POST /api/trpc/permissions.respond", () => {
    const { url, init } = buildRespondRequest(
      { id: "perm-1", decision: "approved" },
      "csrf.tok",
    );
    expect(url).toBe(RESPOND_URL);
    expect(init.method).toBe("POST");
  });

  it("sets content-type and CSRF header", () => {
    const { init } = buildRespondRequest(
      { id: "perm-1", decision: "denied" },
      "csrf.tok",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[CSRF_HEADER]).toBe("csrf.tok");
  });

  it("wraps the input as { json: { id, decision } }", () => {
    const { init } = buildRespondRequest(
      { id: "perm-2", decision: "approved" },
      "tok",
    );
    expect(typeof init.body).toBe("string");
    const parsed = JSON.parse(init.body as string);
    expect(parsed).toEqual({
      json: { id: "perm-2", decision: "approved" },
    });
  });

  it("passes the decision verbatim", () => {
    for (const decision of ["approved", "denied"] as const) {
      const { init } = buildRespondRequest({ id: "x", decision }, "tok");
      const parsed = JSON.parse(init.body as string);
      expect(parsed.json.decision).toBe(decision);
    }
  });
});

describe("RESPOND_URL", () => {
  it("matches the tRPC mutation path", () => {
    expect(RESPOND_URL).toBe("/api/trpc/permissions.respond");
  });
});
