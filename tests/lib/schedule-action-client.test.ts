// P3-T7 — pure helpers in `src/lib/schedule-action-client.ts`. Mirrors
// the `loop-mutation-client` test surface: assert wire shape (URL,
// method, headers, body) for each action and exercise the envelope
// unwrapping for both success and error tRPC responses.

import { describe, it, expect } from "bun:test";

import {
  SCHEDULE_ACTION_URL,
  ScheduleActionError,
  buildScheduleActionRequest,
  parseTrpcResponse,
  type ScheduleAction,
} from "../../src/lib/schedule-action-client";
import { CSRF_HEADER } from "../../src/lib/csrf";

const ACTIONS: readonly ScheduleAction[] = ["pause", "resume", "remove"];

describe("buildScheduleActionRequest", () => {
  for (const action of ACTIONS) {
    it(`${action} → POST ${SCHEDULE_ACTION_URL[action]} with json envelope + csrf header`, () => {
      const { url, init } = buildScheduleActionRequest(
        action,
        { id: 42 },
        "csrf-tok",
      );
      expect(url).toBe(SCHEDULE_ACTION_URL[action]);
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers["content-type"]).toBe("application/json");
      expect(headers[CSRF_HEADER]).toBe("csrf-tok");
      expect(JSON.parse(init.body as string)).toEqual({ json: { id: 42 } });
    });
  }

  it("URL table covers exactly the three actions", () => {
    expect(Object.keys(SCHEDULE_ACTION_URL).sort()).toEqual([
      "pause",
      "remove",
      "resume",
    ]);
  });
});

describe("parseTrpcResponse", () => {
  it("unwraps un-transformed success envelope", () => {
    const out = parseTrpcResponse<{ ok: true }>({
      result: { data: { ok: true } },
    });
    expect(out).toEqual({ ok: true });
  });

  it("unwraps json-wrapped success envelope (forward-compat with transformer)", () => {
    const out = parseTrpcResponse<{ ok: true }>({
      result: { data: { json: { ok: true } } },
    });
    expect(out).toEqual({ ok: true });
  });

  it("throws ScheduleActionError for the error envelope, propagating code + message", () => {
    let caught: ScheduleActionError | null = null;
    try {
      parseTrpcResponse({
        error: {
          message: "schedule not found",
          data: { code: "NOT_FOUND" },
        },
      });
    } catch (e) {
      caught = e as ScheduleActionError;
    }
    expect(caught).toBeInstanceOf(ScheduleActionError);
    expect(caught!.code).toBe("NOT_FOUND");
    expect(caught!.message).toBe("schedule not found");
  });

  it("falls back to INTERNAL_SERVER_ERROR when error.data.code missing", () => {
    let caught: ScheduleActionError | null = null;
    try {
      parseTrpcResponse({ error: { message: "boom" } });
    } catch (e) {
      caught = e as ScheduleActionError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    expect(caught!.message).toBe("boom");
  });

  it("throws on a malformed (non-object) value", () => {
    let caught: ScheduleActionError | null = null;
    try {
      parseTrpcResponse(null);
    } catch (e) {
      caught = e as ScheduleActionError;
    }
    expect(caught).toBeInstanceOf(ScheduleActionError);
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("throws on an envelope without result/error", () => {
    let caught: ScheduleActionError | null = null;
    try {
      parseTrpcResponse({ noise: 123 });
    } catch (e) {
      caught = e as ScheduleActionError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
