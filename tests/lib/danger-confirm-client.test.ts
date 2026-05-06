// P2-T11 — pure browser helpers for the danger-confirm dialog. No DOM,
// no React; just RequestInit assembly for `tasks.kill` and a string-
// match guard for the typed-confirmation token. Mirrors the contract
// that `src/lib/csrf.ts` (server) and the kill-task button (browser)
// agree on the wire format.

import { describe, it, expect } from "bun:test";

import { CSRF_HEADER } from "../../src/lib/csrf";
import {
  KILL_TASK_URL,
  buildKillTaskRequest,
  isConfirmationMatch,
} from "../../src/lib/danger-confirm-client";

describe("KILL_TASK_URL", () => {
  it("targets the tRPC tasks.kill mutation route", () => {
    expect(KILL_TASK_URL).toBe("/api/trpc/tasks.kill");
  });
});

describe("buildKillTaskRequest", () => {
  it("returns the kill URL with method=POST", () => {
    const { url, init } = buildKillTaskRequest({ id: 42 }, "csrf-x");
    expect(url).toBe(KILL_TASK_URL);
    expect(init.method).toBe("POST");
  });

  it("sets the JSON content-type header", () => {
    const { init } = buildKillTaskRequest({ id: 42 }, "csrf-x");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("sets the CSRF header from the supplied token", () => {
    const { init } = buildKillTaskRequest({ id: 42 }, "csrf-x");
    const headers = init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe("csrf-x");
  });

  it("emits the input flat on the body (no json wrapper)", () => {
    const { init } = buildKillTaskRequest({ id: 42 }, "csrf-x");
    expect(init.body).toBe('{"id":42}');
    const parsed = JSON.parse(init.body as string);
    expect(parsed).toEqual({ id: 42 });
  });

  it("does not include unrelated keys (no agentName / model leakage)", () => {
    const { init } = buildKillTaskRequest({ id: 7 }, "csrf-x");
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["id"]);
  });
});

describe("isConfirmationMatch", () => {
  it("matches when the typed value equals the expected token", () => {
    expect(isConfirmationMatch("alpha", "alpha")).toBe(true);
  });

  it("trims surrounding whitespace before comparing", () => {
    expect(isConfirmationMatch("  alpha  ", "alpha")).toBe(true);
  });

  it("trims a trailing newline before comparing", () => {
    expect(isConfirmationMatch("alpha\n", "alpha")).toBe(true);
  });

  it("is case-sensitive (Alpha != alpha)", () => {
    expect(isConfirmationMatch("Alpha", "alpha")).toBe(false);
  });

  it("returns false for an empty input even when expected is empty", () => {
    expect(isConfirmationMatch("", "")).toBe(false);
  });

  it("returns false when expected is empty (defence — never auto-pass)", () => {
    expect(isConfirmationMatch("anything", "")).toBe(false);
  });

  it("returns false when input is whitespace-only", () => {
    expect(isConfirmationMatch("   ", "alpha")).toBe(false);
  });

  it("returns false when the input is non-empty but does not match", () => {
    expect(isConfirmationMatch("beta", "alpha")).toBe(false);
  });
});
