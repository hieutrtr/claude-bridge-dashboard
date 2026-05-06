// P3-T3 — pure-helper tests for the start-loop dialog.

import { describe, it, expect } from "bun:test";

import {
  buildLoopStartRequest,
  composeDoneWhen,
  isValidDoneWhen,
  LoopStartError,
  LOOP_START_URL,
  parseTrpcResponse,
} from "../../src/lib/loop-start-client";
import { CSRF_HEADER } from "../../src/lib/csrf";

describe("composeDoneWhen", () => {
  it("manual + empty value → 'manual:'", () => {
    expect(composeDoneWhen("manual", "")).toBe("manual:");
    expect(composeDoneWhen("manual", "   ")).toBe("manual:");
  });

  it("manual + value → 'manual: <value>'", () => {
    expect(composeDoneWhen("manual", "stop here")).toBe("manual: stop here");
  });

  it("non-manual prefixes always render the colon-space-value form", () => {
    expect(composeDoneWhen("command", "bun test")).toBe("command: bun test");
    expect(composeDoneWhen("file_exists", "/tmp/done")).toBe(
      "file_exists: /tmp/done",
    );
    expect(composeDoneWhen("file_contains", "README OK")).toBe(
      "file_contains: README OK",
    );
    expect(composeDoneWhen("llm_judge", "tests pass")).toBe(
      "llm_judge: tests pass",
    );
  });

  it("trims whitespace from the user-typed value", () => {
    expect(composeDoneWhen("command", "  bun test  ")).toBe("command: bun test");
  });
});

describe("isValidDoneWhen", () => {
  it("accepts every server-recognized prefix", () => {
    expect(isValidDoneWhen("manual:")).toBe(true);
    expect(isValidDoneWhen("manual: stop here")).toBe(true);
    expect(isValidDoneWhen("command: bun test")).toBe(true);
    expect(isValidDoneWhen("file_exists: /tmp/done")).toBe(true);
    expect(isValidDoneWhen("file_contains: README OK")).toBe(true);
    expect(isValidDoneWhen("llm_judge: tests pass")).toBe(true);
  });

  it("rejects empty / unknown / oversized inputs", () => {
    expect(isValidDoneWhen("")).toBe(false);
    expect(isValidDoneWhen("wrong-prefix: anything")).toBe(false);
    expect(isValidDoneWhen("manual")).toBe(false); // missing colon
    expect(isValidDoneWhen("x".repeat(2_001))).toBe(false);
  });
});

describe("buildLoopStartRequest", () => {
  it("builds POST with json envelope + csrf header", () => {
    const { url, init } = buildLoopStartRequest(
      {
        agentName: "alpha",
        goal: "ship it",
        doneWhen: "manual:",
      },
      "csrf-tok-123",
    );
    expect(url).toBe(LOOP_START_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[CSRF_HEADER]).toBe("csrf-tok-123");
    expect(JSON.parse(init.body as string)).toEqual({
      json: {
        agentName: "alpha",
        goal: "ship it",
        doneWhen: "manual:",
      },
    });
  });

  it("includes optional fields only when defined (no `undefined` keys)", () => {
    const { init } = buildLoopStartRequest(
      {
        agentName: "alpha",
        goal: "ship it",
        doneWhen: "manual:",
        maxIterations: 8,
        loopType: "bridge",
        planFirst: false,
      },
      "tok",
    );
    const body = JSON.parse(init.body as string);
    expect(body.json).toEqual({
      agentName: "alpha",
      goal: "ship it",
      doneWhen: "manual:",
      maxIterations: 8,
      loopType: "bridge",
      planFirst: false,
    });
  });
});

describe("parseTrpcResponse", () => {
  it("unwraps the un-transformed `{result: {data: T}}` envelope", () => {
    const out = parseTrpcResponse<{ loopId: string }>({
      result: { data: { loopId: "loop-123" } },
    });
    expect(out).toEqual({ loopId: "loop-123" });
  });

  it("unwraps the json-wrapped `{result: {data: {json: T}}}` envelope", () => {
    const out = parseTrpcResponse<{ loopId: string }>({
      result: { data: { json: { loopId: "loop-456" } } },
    });
    expect(out).toEqual({ loopId: "loop-456" });
  });

  it("throws LoopStartError on the error envelope (with typed code)", () => {
    let caught: LoopStartError | null = null;
    try {
      parseTrpcResponse({
        error: {
          message: "rate limited",
          data: { code: "TOO_MANY_REQUESTS" },
        },
      });
    } catch (e) {
      caught = e as LoopStartError;
    }
    expect(caught).toBeInstanceOf(LoopStartError);
    expect(caught!.code).toBe("TOO_MANY_REQUESTS");
    expect(caught!.message).toBe("rate limited");
  });

  it("throws on a malformed envelope (no result, no error)", () => {
    let caught: LoopStartError | null = null;
    try {
      parseTrpcResponse({ unexpected: 1 });
    } catch (e) {
      caught = e as LoopStartError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
