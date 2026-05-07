// P4-T11 — telemetry-client unit tests.
//
// Pure browser helper coverage:
//   * `buildSetOptInRequest` — emits the correct URL, CSRF header, JSON body.
//   * `buildRecordRequest` — sanitises eventName client-side before
//     building the request body; returns `{ ok: false }` for PII inputs.
//   * `recordTelemetry` — fetch-impl seam; returns null on missing CSRF;
//     returns null when build skips; surfaces server response on accept.

import { describe, it, expect } from "bun:test";

import {
  TELEMETRY_RECORD_URL,
  TELEMETRY_SET_OPT_IN_URL,
  buildRecordRequest,
  buildSetOptInRequest,
  recordTelemetry,
  type RecordEventResult,
} from "../../src/lib/telemetry-client";
import { CSRF_HEADER } from "../../src/lib/csrf";

describe("buildSetOptInRequest", () => {
  it("posts JSON to the canonical tRPC URL with the CSRF header", () => {
    const { url, init } = buildSetOptInRequest({ enabled: true }, "csrf-tok-123");
    expect(url).toBe(TELEMETRY_SET_OPT_IN_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[CSRF_HEADER]).toBe("csrf-tok-123");
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
  });
});

describe("buildRecordRequest", () => {
  it("returns ok with sanitised event name for clean input", () => {
    const out = buildRecordRequest(
      { eventType: "page_view", eventName: "/tasks/0123456789abcdef" },
      "csrf",
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.url).toBe(TELEMETRY_RECORD_URL);
    expect(out.eventName).toBe("/tasks/[id]");
    const body = JSON.parse((out.init.body as string) ?? "{}");
    expect(body).toEqual({
      eventType: "page_view",
      eventName: "/tasks/[id]",
      valueMs: null,
    });
  });

  it("clamps valueMs into the safe band", () => {
    const out = buildRecordRequest(
      { eventType: "action_latency", eventName: "dispatch.success", valueMs: 1_000_000 },
      "csrf",
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    const body = JSON.parse((out.init.body as string) ?? "{}");
    expect(body.valueMs).toBe(600_000);
  });

  it("rejects email-shaped event names", () => {
    const out = buildRecordRequest(
      { eventType: "page_view", eventName: "/users/me@bridge.dev" },
      "csrf",
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected skip");
    expect(out.reason).toBe("email");
  });

  it("rejects non-whitelisted event types", () => {
    const out = buildRecordRequest(
      // @ts-expect-error — narrow in app code, widen for runtime check
      { eventType: "click", eventName: "/agents" },
      "csrf",
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected skip");
    expect(out.reason).toBe("type");
  });
});

describe("recordTelemetry", () => {
  it("returns null when csrf is missing (no fetch attempt)", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    const out = await recordTelemetry(
      { eventType: "page_view", eventName: "/agents" },
      null,
      { fetchImpl },
    );
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null when input would be skipped by the scrubber", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    const out = await recordTelemetry(
      { eventType: "page_view", eventName: "/users/leak@bridge.dev" },
      "csrf",
      { fetchImpl },
    );
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it("posts to the canonical URL and returns the server result on accept", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      const body = {
        result: {
          data: {
            json: {
              status: "accepted",
              id: 42,
              eventName: "/agents",
              reason: null,
            },
          },
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = (await recordTelemetry(
      { eventType: "page_view", eventName: "/agents" },
      "csrf",
      { fetchImpl },
    )) as RecordEventResult | null;
    expect(out).not.toBeNull();
    expect(out!.status).toBe("accepted");
    expect(out!.id).toBe(42);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(TELEMETRY_RECORD_URL);
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe("csrf");
  });

  it("surfaces dropped_off result when server reports opt-in OFF", async () => {
    const fetchImpl = (async () => {
      const body = {
        result: {
          data: {
            json: {
              status: "dropped_off",
              id: null,
              eventName: null,
              reason: null,
            },
          },
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = await recordTelemetry(
      { eventType: "page_view", eventName: "/agents" },
      "csrf",
      { fetchImpl },
    );
    expect(out?.status).toBe("dropped_off");
  });
});
