// P3-T4 — pure helpers in `src/lib/loop-mutation-client.ts`. Mirrors
// the `loop-start-client` test surface: assert the wire shape (URL,
// method, headers, body) and the envelope unwrapping for both success
// and error tRPC responses.

import { describe, it, expect } from "bun:test";

import {
  LOOP_APPROVE_URL,
  LOOP_CANCEL_URL,
  LOOP_REJECT_URL,
  LoopMutationError,
  buildLoopApproveRequest,
  buildLoopCancelRequest,
  buildLoopRejectRequest,
  parseTrpcResponse,
} from "../../src/lib/loop-mutation-client";
import { CSRF_HEADER } from "../../src/lib/csrf";

describe("buildLoopCancelRequest", () => {
  it("targets POST /api/trpc/loops.cancel with json envelope + csrf header", () => {
    const { url, init } = buildLoopCancelRequest({ loopId: "loop-1" }, "csrf-tok");
    expect(url).toBe(LOOP_CANCEL_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[CSRF_HEADER]).toBe("csrf-tok");
    expect(JSON.parse(init.body as string)).toEqual({ loopId: "loop-1" });
  });
});

describe("buildLoopApproveRequest", () => {
  it("targets /loops.approve with the loopId payload", () => {
    const { url, init } = buildLoopApproveRequest({ loopId: "loop-2" }, "tok2");
    expect(url).toBe(LOOP_APPROVE_URL);
    expect(JSON.parse(init.body as string)).toEqual({ loopId: "loop-2" });
  });
});

describe("buildLoopRejectRequest", () => {
  it("includes reason when set", () => {
    const { init } = buildLoopRejectRequest(
      { loopId: "loop-3", reason: "bad output" },
      "tok",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      loopId: "loop-3",
      reason: "bad output",
    });
  });

  it("omits reason key when undefined (matches Zod .optional() expectation)", () => {
    const { init, url } = buildLoopRejectRequest({ loopId: "loop-3" }, "tok");
    expect(url).toBe(LOOP_REJECT_URL);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ loopId: "loop-3" });
    expect(Object.keys(body)).not.toContain("reason");
  });
});

describe("parseTrpcResponse", () => {
  it("unwraps un-transformed success envelope", () => {
    const out = parseTrpcResponse<{ ok: true; alreadyFinalized: boolean }>({
      result: { data: { ok: true, alreadyFinalized: false } },
    });
    expect(out).toEqual({ ok: true, alreadyFinalized: false });
  });

  it("unwraps json-wrapped success envelope (forward-compat with transformer)", () => {
    const out = parseTrpcResponse<{ ok: true; alreadyFinalized: boolean }>({
      result: { data: { json: { ok: true, alreadyFinalized: true } } },
    });
    expect(out).toEqual({ ok: true, alreadyFinalized: true });
  });

  it("throws LoopMutationError for the error envelope, propagating code + message", () => {
    let caught: LoopMutationError | null = null;
    try {
      parseTrpcResponse({
        error: {
          message: "rate-limited",
          data: { code: "TOO_MANY_REQUESTS" },
        },
      });
    } catch (e) {
      caught = e as LoopMutationError;
    }
    expect(caught).toBeInstanceOf(LoopMutationError);
    expect(caught!.code).toBe("TOO_MANY_REQUESTS");
    expect(caught!.message).toBe("rate-limited");
  });

  it("falls back to INTERNAL_SERVER_ERROR when error.data.code missing", () => {
    let caught: LoopMutationError | null = null;
    try {
      parseTrpcResponse({ error: { message: "boom" } });
    } catch (e) {
      caught = e as LoopMutationError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    expect(caught!.message).toBe("boom");
  });

  it("throws on a malformed (non-object) value", () => {
    let caught: LoopMutationError | null = null;
    try {
      parseTrpcResponse(null);
    } catch (e) {
      caught = e as LoopMutationError;
    }
    expect(caught).toBeInstanceOf(LoopMutationError);
  });

  it("throws on an envelope without result/error", () => {
    let caught: LoopMutationError | null = null;
    try {
      parseTrpcResponse({ noise: 123 });
    } catch (e) {
      caught = e as LoopMutationError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
