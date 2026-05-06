// P3-T8 — pure helpers in `src/lib/schedule-runs-client.ts`. Mirrors
// `schedule-action-client.test.ts`: assert wire shape (URL, method,
// query string) for the drawer's GET query, and exercise the
// envelope unwrapping for both success and error tRPC responses.

import { describe, it, expect } from "bun:test";

import {
  SCHEDULE_RUNS_URL,
  ScheduleRunsError,
  buildScheduleRunsRequest,
  parseTrpcResponse,
} from "../../src/lib/schedule-runs-client";

describe("buildScheduleRunsRequest", () => {
  it("encodes id-only input on the URL; default limit omitted", () => {
    const { url, init } = buildScheduleRunsRequest({ id: 42 });
    expect(init.method).toBe("GET");
    // The server applies the default limit (30) when omitted.
    const decoded = JSON.parse(
      decodeURIComponent(url.split("?input=")[1]!),
    );
    expect(decoded).toEqual({ id: 42 });
    expect(url.startsWith(SCHEDULE_RUNS_URL)).toBe(true);
  });

  it("forwards explicit limit on the URL", () => {
    const { url } = buildScheduleRunsRequest({ id: 7, limit: 5 });
    const decoded = JSON.parse(
      decodeURIComponent(url.split("?input=")[1]!),
    );
    expect(decoded).toEqual({ id: 7, limit: 5 });
  });

  it("does not include any CSRF header (GET — safe method)", () => {
    const { init } = buildScheduleRunsRequest({ id: 1 });
    expect(init.headers).toBeUndefined();
  });
});

describe("parseTrpcResponse", () => {
  it("unwraps un-transformed success envelope", () => {
    const out = parseTrpcResponse({
      result: {
        data: {
          scheduleId: 1,
          scheduleName: "n",
          agentName: "a",
          items: [],
        },
      },
    });
    expect(out.scheduleId).toBe(1);
    expect(out.items).toEqual([]);
  });

  it("unwraps json-wrapped success envelope", () => {
    const out = parseTrpcResponse({
      result: {
        data: {
          json: {
            scheduleId: 2,
            scheduleName: "n2",
            agentName: "a",
            items: [],
          },
        },
      },
    });
    expect(out.scheduleId).toBe(2);
  });

  it("throws ScheduleRunsError for the error envelope, propagating code + message", () => {
    let caught: ScheduleRunsError | null = null;
    try {
      parseTrpcResponse({
        error: { message: "schedule not found", data: { code: "NOT_FOUND" } },
      });
    } catch (e) {
      caught = e as ScheduleRunsError;
    }
    expect(caught).toBeInstanceOf(ScheduleRunsError);
    expect(caught!.code).toBe("NOT_FOUND");
    expect(caught!.message).toBe("schedule not found");
  });

  it("falls back to INTERNAL_SERVER_ERROR when error.data.code missing", () => {
    let caught: ScheduleRunsError | null = null;
    try {
      parseTrpcResponse({ error: { message: "boom" } });
    } catch (e) {
      caught = e as ScheduleRunsError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    expect(caught!.message).toBe("boom");
  });

  it("throws on a malformed (non-object) value", () => {
    let caught: ScheduleRunsError | null = null;
    try {
      parseTrpcResponse(null);
    } catch (e) {
      caught = e as ScheduleRunsError;
    }
    expect(caught).toBeInstanceOf(ScheduleRunsError);
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("throws on an envelope without result/error", () => {
    let caught: ScheduleRunsError | null = null;
    try {
      parseTrpcResponse({ noise: 123 });
    } catch (e) {
      caught = e as ScheduleRunsError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
