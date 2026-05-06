// P2-T02 — pure browser helpers for the dispatch dialog. No DOM, no
// React; just cookie parsing, RequestInit assembly, and tRPC v11
// response envelope unwrapping. Mirrors the invariant that
// `src/lib/csrf.ts` (server) and `src/lib/dispatch-client.ts` (browser)
// agree on the cookie name and header on the wire.

import { describe, it, expect } from "bun:test";

import {
  CSRF_COOKIE,
  CSRF_HEADER,
} from "../../src/lib/csrf";
import {
  AGENTS_LIST_URL,
  DISPATCH_URL,
  DispatchError,
  buildAgentsListRequest,
  buildDispatchRequest,
  parseTrpcResponse,
  readCsrfTokenFromCookie,
} from "../../src/lib/dispatch-client";

describe("readCsrfTokenFromCookie", () => {
  it("returns the bridge token from a multi-cookie string", () => {
    const cookie = `theme=dark; ${CSRF_COOKIE}=abc.def; bridge_session=xyz`;
    expect(readCsrfTokenFromCookie(cookie)).toBe("abc.def");
  });

  it("returns null for an empty cookie string", () => {
    expect(readCsrfTokenFromCookie("")).toBeNull();
    expect(readCsrfTokenFromCookie(null)).toBeNull();
    expect(readCsrfTokenFromCookie(undefined)).toBeNull();
  });

  it("returns null when the bridge cookie is absent", () => {
    expect(readCsrfTokenFromCookie("theme=dark; foo=bar")).toBeNull();
  });

  it("ignores cookies that share a prefix with the bridge cookie name", () => {
    // Defensive: a cookie called `bridge_csrf_tokenizer=foo` must not
    // be confused with `bridge_csrf_token=...`.
    const cookie = `${CSRF_COOKIE}izer=spoof; theme=dark`;
    expect(readCsrfTokenFromCookie(cookie)).toBeNull();
  });

  it("trims whitespace around cookie names and values", () => {
    const cookie = ` ${CSRF_COOKIE} = abc.def ; theme=dark`;
    expect(readCsrfTokenFromCookie(cookie)).toBe("abc.def");
  });

  it("returns the first match when the cookie repeats", () => {
    // RFC 6265 forbids duplicate names; if the browser sends two we
    // honour the first (matches `csrf-guard.parseCookie` server
    // semantics).
    const cookie = `${CSRF_COOKIE}=first; ${CSRF_COOKIE}=second`;
    expect(readCsrfTokenFromCookie(cookie)).toBe("first");
  });
});

describe("buildDispatchRequest", () => {
  it("produces POST /api/trpc/tasks.dispatch with json + csrf headers", () => {
    const { url, init } = buildDispatchRequest(
      { agentName: "alpha", prompt: "hi" },
      "csrf.tok",
    );
    expect(url).toBe(DISPATCH_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[CSRF_HEADER]).toBe("csrf.tok");
  });

  it("omits the model field from the JSON body when undefined", () => {
    const { init } = buildDispatchRequest(
      { agentName: "alpha", prompt: "hi" },
      "csrf.tok",
    );
    expect(typeof init.body).toBe("string");
    const parsed = JSON.parse(init.body as string);
    expect(parsed).toEqual({ json: { agentName: "alpha", prompt: "hi" } });
  });

  it("includes the model field when provided", () => {
    const { init } = buildDispatchRequest(
      { agentName: "alpha", prompt: "hi", model: "sonnet" },
      "csrf.tok",
    );
    const parsed = JSON.parse(init.body as string);
    expect(parsed).toEqual({
      json: { agentName: "alpha", prompt: "hi", model: "sonnet" },
    });
  });
});

describe("buildAgentsListRequest", () => {
  it("produces a GET to /api/trpc/agents.list with no body or csrf header", () => {
    const { url, init } = buildAgentsListRequest();
    expect(url).toBe(AGENTS_LIST_URL);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBeUndefined();
  });
});

describe("parseTrpcResponse", () => {
  it("returns result.data for the success envelope", () => {
    const env = { result: { data: { taskId: 42 } } };
    expect(parseTrpcResponse<{ taskId: number }>(env)).toEqual({ taskId: 42 });
  });

  it("returns result.data when the envelope nests a json wrapper", () => {
    // tRPC v11 with the `httpBatchLink` `transformer` adds a `json`
    // key under `data`. We tolerate both shapes so the parser stays
    // forward-compatible.
    const env = { result: { data: { json: { taskId: 7 } } } };
    expect(parseTrpcResponse<{ taskId: number }>(env)).toEqual({ taskId: 7 });
  });

  it("throws DispatchError with code + message from the error envelope", () => {
    const env = {
      error: {
        message: "Daemon did not respond within timeout",
        code: -32008,
        data: { code: "TIMEOUT", httpStatus: 408 },
      },
    };
    let caught: unknown = null;
    try {
      parseTrpcResponse(env);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DispatchError);
    expect((caught as DispatchError).code).toBe("TIMEOUT");
    expect((caught as DispatchError).message).toBe(
      "Daemon did not respond within timeout",
    );
  });

  it("falls back to INTERNAL_SERVER_ERROR when the error data is missing", () => {
    const env = { error: { message: "something broke" } };
    let caught: DispatchError | null = null;
    try {
      parseTrpcResponse(env);
    } catch (err) {
      caught = err as DispatchError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    expect(caught!.message).toBe("something broke");
  });

  it("throws INTERNAL_SERVER_ERROR for malformed JSON envelopes", () => {
    let caught: DispatchError | null = null;
    try {
      parseTrpcResponse({ neither: "ok" });
    } catch (err) {
      caught = err as DispatchError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("DispatchError", () => {
  it("is an Error subclass with code + message", () => {
    const err = new DispatchError("TIMEOUT", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toBe("boom");
    expect(err.name).toBe("DispatchError");
  });
});
