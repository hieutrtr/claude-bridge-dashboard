// P4-T06 — `src/lib/notifications-client.ts` unit tests. Pure module,
// no DOM/React. Mirrors `tests/lib/users-client.test.ts`.

import { describe, it, expect } from "bun:test";

import {
  HOURS,
  NotificationsMutationError,
  buildResetRequest,
  buildUpdateRequest,
  diffPrefs,
  formatHour,
  isValidTimezone,
  parseTrpcResponse,
  type NotificationsPrefsResponse,
} from "../../src/lib/notifications-client";

const SAMPLE_PREFS: NotificationsPrefsResponse = {
  inAppEnabled: true,
  emailDigestEnabled: false,
  emailDigestHour: 9,
  emailDigestTz: "UTC",
  browserPushEnabled: false,
  updatedAt: 1_700_000_000_000,
};

describe("HOURS", () => {
  it("contains 24 entries 0..23", () => {
    expect(HOURS.length).toBe(24);
    expect(HOURS[0]).toBe(0);
    expect(HOURS[23]).toBe(23);
  });
});

describe("formatHour", () => {
  it("zero-pads the hour", () => {
    expect(formatHour(0)).toBe("00:00");
    expect(formatHour(9)).toBe("09:00");
    expect(formatHour(23)).toBe("23:00");
  });

  it("returns -- for invalid input", () => {
    expect(formatHour(-1)).toBe("--:--");
    expect(formatHour(24)).toBe("--:--");
    expect(formatHour(2.5)).toBe("--:--");
  });
});

describe("isValidTimezone", () => {
  it("accepts canonical IANA strings", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Asia/Saigon")).toBe(true);
    expect(isValidTimezone("America/Los_Angeles")).toBe(true);
    expect(isValidTimezone("Etc/GMT+12")).toBe(true);
    expect(isValidTimezone("Etc/GMT-12")).toBe(true);
  });

  it("rejects empty / oversize / illegal chars", () => {
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("a".repeat(65))).toBe(false);
    expect(isValidTimezone("Asia/Saigon; DROP TABLE users")).toBe(false);
    expect(isValidTimezone("$bad")).toBe(false);
    expect(isValidTimezone("1Bad/Start")).toBe(false);
  });
});

describe("buildUpdateRequest / buildResetRequest", () => {
  it("update sends POST + CSRF + body", () => {
    const { url, init } = buildUpdateRequest(
      { emailDigestEnabled: true },
      "csrf-abc",
    );
    expect(url).toBe("/api/trpc/notifications.update");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBe("csrf-abc");
    expect(JSON.parse(init.body as string)).toEqual({
      emailDigestEnabled: true,
    });
  });

  it("reset sends POST + CSRF + empty body", () => {
    const { url, init } = buildResetRequest("csrf-xyz");
    expect(url).toBe("/api/trpc/notifications.reset");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBe("csrf-xyz");
    expect(JSON.parse(init.body as string)).toEqual({});
  });
});

describe("parseTrpcResponse", () => {
  it("unwraps result.data", () => {
    const out = parseTrpcResponse<{ ok: boolean }>({
      result: { data: { ok: true } },
    });
    expect(out).toEqual({ ok: true });
  });

  it("unwraps result.data.json (transformer wrapper)", () => {
    const out = parseTrpcResponse<{ ok: boolean }>({
      result: { data: { json: { ok: true } } },
    });
    expect(out).toEqual({ ok: true });
  });

  it("throws NotificationsMutationError on error envelope", () => {
    expect(() =>
      parseTrpcResponse({
        error: {
          message: "owner role required",
          data: { code: "FORBIDDEN" },
        },
      }),
    ).toThrow(NotificationsMutationError);
  });

  it("propagates the error code + message", () => {
    try {
      parseTrpcResponse({
        error: {
          message: "owner role required",
          data: { code: "FORBIDDEN" },
        },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(NotificationsMutationError);
      expect((err as NotificationsMutationError).code).toBe("FORBIDDEN");
      expect((err as NotificationsMutationError).message).toBe(
        "owner role required",
      );
    }
  });

  it("rejects malformed top-level shapes", () => {
    expect(() => parseTrpcResponse(null)).toThrow();
    expect(() => parseTrpcResponse("oops")).toThrow();
    expect(() => parseTrpcResponse({ unrelated: true })).toThrow();
  });
});

describe("diffPrefs", () => {
  it("returns empty list when prefs are identical", () => {
    expect(diffPrefs(SAMPLE_PREFS, SAMPLE_PREFS)).toEqual([]);
  });

  it("detects boolean flips", () => {
    const next = { ...SAMPLE_PREFS, emailDigestEnabled: true };
    expect(diffPrefs(SAMPLE_PREFS, next)).toEqual(["emailDigestEnabled"]);
  });

  it("detects multiple field changes in stable order", () => {
    const next = {
      ...SAMPLE_PREFS,
      inAppEnabled: false,
      emailDigestEnabled: true,
      emailDigestHour: 8,
      emailDigestTz: "Asia/Saigon",
      browserPushEnabled: true,
    };
    expect(diffPrefs(SAMPLE_PREFS, next)).toEqual([
      "inAppEnabled",
      "emailDigestEnabled",
      "emailDigestHour",
      "emailDigestTz",
      "browserPushEnabled",
    ]);
  });

  it("ignores updatedAt drift", () => {
    const next = { ...SAMPLE_PREFS, updatedAt: 1_900_000_000_000 };
    expect(diffPrefs(SAMPLE_PREFS, next)).toEqual([]);
  });
});
