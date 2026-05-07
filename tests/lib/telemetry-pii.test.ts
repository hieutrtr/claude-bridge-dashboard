// P4-T11 — PII scrubber unit tests.
//
// The scrubber is the load-bearing privacy boundary. Every event flows
// through it twice (client + server). These tests exhaustively assert:
//   * The whitelist of event types.
//   * Routes with embedded IDs (UUID, hex, long digits) get rewritten.
//   * Emails / IPv4 / query strings / file paths / non-ASCII are
//     rejected (return null).
//   * Length limits are enforced.
//   * `clampValueMs` coerces durations into the safe band.
//
// If a test in this file regresses, telemetry has a privacy hole. Take
// it seriously — these are the gates the v1 ARCH §10 + Phase 4 INDEX
// invariant rely on.

import { describe, it, expect } from "bun:test";

import {
  TELEMETRY_EVENT_TYPES,
  TELEMETRY_LIMITS,
  clampValueMs,
  containsPii,
  sanitiseEventName,
  sanitiseEventType,
} from "../../src/lib/telemetry-pii";

describe("TELEMETRY_EVENT_TYPES", () => {
  it("exposes exactly the three plan-defined event types", () => {
    expect(TELEMETRY_EVENT_TYPES).toEqual([
      "page_view",
      "action_latency",
      "feature_used",
    ]);
  });
});

describe("sanitiseEventType", () => {
  for (const t of TELEMETRY_EVENT_TYPES) {
    it(`accepts the whitelisted type "${t}"`, () => {
      expect(sanitiseEventType(t)).toBe(t);
    });
  }

  for (const bad of [
    "PAGE_VIEW",
    "page_view ",
    "click",
    "",
    null,
    undefined,
    42,
    {},
  ]) {
    it(`rejects "${String(bad)}"`, () => {
      expect(sanitiseEventType(bad)).toBeNull();
    });
  }
});

describe("sanitiseEventName — happy paths", () => {
  it("passes through plain route names", () => {
    expect(sanitiseEventName("/agents")).toBe("/agents");
    expect(sanitiseEventName("/cost")).toBe("/cost");
    expect(sanitiseEventName("/")).toBe("/");
  });

  it("passes through dot-separated feature keys", () => {
    expect(sanitiseEventName("dispatch.success")).toBe("dispatch.success");
    expect(sanitiseEventName("loop.start")).toBe("loop.start");
    expect(sanitiseEventName("cmdk.open")).toBe("cmdk.open");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitiseEventName("  /agents  ")).toBe("/agents");
  });
});

describe("sanitiseEventName — ID rewrites", () => {
  it("rewrites a UUID in a path segment", () => {
    expect(
      sanitiseEventName("/loops/01abcdef-0123-4567-89ab-cdef01234567"),
    ).toBe("/loops/[id]");
  });

  it("rewrites a long hex token", () => {
    expect(sanitiseEventName("/tasks/0123456789abcdef")).toBe("/tasks/[id]");
  });

  it("rewrites a long numeric id", () => {
    expect(sanitiseEventName("/tasks/12345678")).toBe("/tasks/[id]");
  });

  it("does not rewrite short numeric ids (status codes, version numbers)", () => {
    // Query string is stripped — `/cost?v=2` → `/cost` is accepted.
    expect(sanitiseEventName("/cost?v=2")).toBe("/cost");
    expect(sanitiseEventName("v0.1.0")).toBe("v0.1.0");
  });

  it("strips a query string entirely", () => {
    // After we drop "?…", the leading path remains and is checked.
    expect(sanitiseEventName("/tasks?token=abc")).toBe("/tasks");
    expect(sanitiseEventName("/users/leak@bridge.dev?ref=email")).toBeNull();
  });

  it("rewrites multiple IDs in one path", () => {
    expect(
      sanitiseEventName(
        "/loops/01abcdef-0123-4567-89ab-cdef01234567/runs/0123456789abcdef",
      ),
    ).toBe("/loops/[id]/runs/[id]");
  });
});

describe("sanitiseEventName — PII rejections", () => {
  it("rejects an embedded email address", () => {
    expect(sanitiseEventName("dispatch.foo@example.com")).toBeNull();
    expect(sanitiseEventName("/users/jane@bridge.dev")).toBeNull();
  });

  it("rejects an IPv4 octet", () => {
    expect(sanitiseEventName("/health/127.0.0.1")).toBeNull();
    expect(sanitiseEventName("net.10.0.0.5.error")).toBeNull();
  });

  it("rejects a file system path", () => {
    expect(sanitiseEventName("/Users/hieu/.ssh/key")).toBeNull();
    expect(sanitiseEventName("/home/op/db.sqlite")).toBeNull();
    expect(sanitiseEventName("/var/log/syslog")).toBeNull();
  });

  it("rejects non-ASCII strings", () => {
    expect(sanitiseEventName("/lịch")).toBeNull();
    expect(sanitiseEventName("/page/✓")).toBeNull();
  });

  it("rejects empty / whitespace-only", () => {
    expect(sanitiseEventName("")).toBeNull();
    expect(sanitiseEventName("   ")).toBeNull();
  });

  it("truncates over-long strings to the limit", () => {
    const long = "/long/" + "a".repeat(TELEMETRY_LIMITS.EVENT_NAME_MAX_LEN + 50);
    const out = sanitiseEventName(long);
    expect(out !== null).toBe(true);
    expect((out ?? "").length).toBeLessThanOrEqual(
      TELEMETRY_LIMITS.EVENT_NAME_MAX_LEN,
    );
  });
});

describe("containsPii", () => {
  it("returns ok for clean route names", () => {
    expect(containsPii("/agents").ok).toBe(true);
    expect(containsPii("dispatch.success").ok).toBe(true);
  });

  it("returns the right reason tag for each pattern", () => {
    expect(containsPii("hieu@bridge.dev")).toEqual({ ok: false, reason: "email" });
    expect(containsPii("/health/127.0.0.1")).toEqual({ ok: false, reason: "ipv4" });
    expect(containsPii("/page?token=xyz")).toEqual({
      ok: false,
      reason: "query_string",
    });
    expect(containsPii("/Users/op/key")).toEqual({
      ok: false,
      reason: "file_path",
    });
    expect(containsPii("/lịch")).toEqual({ ok: false, reason: "non_ascii" });
    expect(containsPii("")).toEqual({ ok: false, reason: "empty" });
    expect(
      containsPii("a".repeat(TELEMETRY_LIMITS.EVENT_NAME_MAX_LEN + 1)),
    ).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("clampValueMs", () => {
  it("coerces a positive integer", () => {
    expect(clampValueMs(1234)).toBe(1234);
  });

  it("rounds floats", () => {
    expect(clampValueMs(12.7)).toBe(13);
    expect(clampValueMs(12.3)).toBe(12);
  });

  it("clamps to the upper bound", () => {
    expect(clampValueMs(TELEMETRY_LIMITS.VALUE_MS_MAX + 1000)).toBe(
      TELEMETRY_LIMITS.VALUE_MS_MAX,
    );
    expect(clampValueMs(Number.MAX_SAFE_INTEGER)).toBe(
      TELEMETRY_LIMITS.VALUE_MS_MAX,
    );
  });

  it("returns null for negatives, NaN, Infinity, non-numeric", () => {
    expect(clampValueMs(-1)).toBeNull();
    expect(clampValueMs(Number.NaN)).toBeNull();
    expect(clampValueMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(clampValueMs("not a number")).toBeNull();
  });

  it("returns null for nullish input", () => {
    expect(clampValueMs(null)).toBeNull();
    expect(clampValueMs(undefined)).toBeNull();
  });

  it("parses a numeric string", () => {
    expect(clampValueMs("250")).toBe(250);
  });
});
