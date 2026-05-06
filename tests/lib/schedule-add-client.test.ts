// P3-T6 — pure-helper tests for the schedule-create dialog. Mirrors
// `tests/lib/loop-start-client.test.ts` shape: no DOM, no jsdom; we
// just exercise the cron→interval conversion, request-builder
// envelope, and tRPC response unwrapper.

import { describe, it, expect } from "bun:test";

import {
  CRON_PRESETS,
  ScheduleAddError,
  SCHEDULE_ADD_URL,
  buildScheduleAddRequest,
  cronToIntervalMinutes,
  evaluateCron,
  parseTrpcResponse,
} from "../../src/lib/schedule-add-client";
import { CSRF_HEADER } from "../../src/lib/csrf";

const NOW = new Date("2026-05-06T08:00:00.000Z");

describe("CRON_PRESETS", () => {
  it("includes hourly / daily / weekly + the custom sentinel", () => {
    const values = CRON_PRESETS.map((p) => p.value);
    expect(values).toEqual(["hourly", "daily-9am", "weekly-mon-9am", "custom"]);
  });

  it("each non-custom preset's hard-coded intervalMinutes matches its cron", () => {
    for (const p of CRON_PRESETS) {
      if (p.cronExpr === null) continue;
      const computed = cronToIntervalMinutes(p.cronExpr, NOW);
      expect(computed).toBe(p.intervalMinutes);
    }
  });
});

describe("evaluateCron", () => {
  it("hourly cron → ok, intervalMinutes=60, 3 fire times", () => {
    const out = evaluateCron("0 * * * *", NOW);
    expect(out.status).toBe("ok");
    expect(out.intervalMinutes).toBe(60);
    expect(out.message).toBeNull();
    expect(out.nextFires.length).toBe(3);
    // Each fire time is exactly 60min apart.
    for (let i = 1; i < out.nextFires.length; i++) {
      expect(out.nextFires[i]!.getTime() - out.nextFires[i - 1]!.getTime()).toBe(
        60 * 60_000,
      );
    }
  });

  it("daily 9am → ok, intervalMinutes=1440", () => {
    const out = evaluateCron("0 9 * * *", NOW);
    expect(out.status).toBe("ok");
    expect(out.intervalMinutes).toBe(24 * 60);
  });

  it("weekly Mon 9am → ok, intervalMinutes=10_080", () => {
    const out = evaluateCron("0 9 * * 1", NOW);
    expect(out.status).toBe("ok");
    expect(out.intervalMinutes).toBe(7 * 24 * 60);
  });

  it("weekday cron `0 9 * * 1-5` → non-uniform reject", () => {
    const out = evaluateCron("0 9 * * 1-5", NOW);
    expect(out.status).toBe("non-uniform");
    expect(out.intervalMinutes).toBeNull();
    expect(out.message).toMatch(/uniform/i);
    // Even though invalid for the daemon, we still return the next-3
    // fire times so the user sees what they're aiming at.
    expect(out.nextFires.length).toBe(3);
  });

  it("malformed cron expression → status=null + parse-error message", () => {
    const out = evaluateCron("not a cron", NOW);
    expect(out.status).toBeNull();
    expect(out.intervalMinutes).toBeNull();
    expect(out.message).not.toBeNull();
    expect(out.nextFires).toEqual([]);
  });

  it("empty string → status=null + 'Empty cron expression' message", () => {
    const out = evaluateCron("", NOW);
    expect(out.status).toBeNull();
    expect(out.message).toMatch(/empty/i);
    expect(out.nextFires).toEqual([]);
  });

  it("trims surrounding whitespace before parsing", () => {
    const out = evaluateCron("   0 * * * *   ", NOW);
    expect(out.status).toBe("ok");
    expect(out.cronExpr).toBe("0 * * * *");
  });

  it("every-15-minutes cron → ok, intervalMinutes=15", () => {
    const out = evaluateCron("*/15 * * * *", NOW);
    expect(out.status).toBe("ok");
    expect(out.intervalMinutes).toBe(15);
  });
});

describe("cronToIntervalMinutes", () => {
  it("returns null for invalid OR non-uniform expressions", () => {
    expect(cronToIntervalMinutes("not a cron", NOW)).toBeNull();
    expect(cronToIntervalMinutes("0 9 * * 1-5", NOW)).toBeNull();
  });

  it("returns positive minutes for uniform expressions", () => {
    expect(cronToIntervalMinutes("0 * * * *", NOW)).toBe(60);
  });
});

describe("buildScheduleAddRequest", () => {
  it("builds POST with json envelope + csrf header (required fields only)", () => {
    const { url, init } = buildScheduleAddRequest(
      {
        agentName: "alpha",
        prompt: "run nightly",
        intervalMinutes: 1440,
      },
      "csrf-tok-xyz",
    );
    expect(url).toBe(SCHEDULE_ADD_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[CSRF_HEADER]).toBe("csrf-tok-xyz");
    expect(JSON.parse(init.body as string)).toEqual({
      json: {
        agentName: "alpha",
        prompt: "run nightly",
        intervalMinutes: 1440,
      },
    });
  });

  it("includes optional fields only when defined (no `undefined` keys)", () => {
    const { init } = buildScheduleAddRequest(
      {
        agentName: "alpha",
        prompt: "run hourly",
        intervalMinutes: 60,
        name: "nightly-tests",
        cronExpr: "0 * * * *",
      },
      "tok",
    );
    const body = JSON.parse(init.body as string);
    expect(body.json).toEqual({
      agentName: "alpha",
      prompt: "run hourly",
      intervalMinutes: 60,
      name: "nightly-tests",
      cronExpr: "0 * * * *",
    });
    // channelChatId not provided → must NOT be in the envelope.
    expect(body.json.channelChatId).toBeUndefined();
  });

  it("forwards channelChatId verbatim when supplied", () => {
    const { init } = buildScheduleAddRequest(
      {
        agentName: "alpha",
        prompt: "x",
        intervalMinutes: 60,
        channelChatId: "telegram-chat-12345",
      },
      "tok",
    );
    const body = JSON.parse(init.body as string);
    expect(body.json.channelChatId).toBe("telegram-chat-12345");
  });
});

describe("parseTrpcResponse", () => {
  it("unwraps `result.data` (un-transformed envelope)", () => {
    const out = parseTrpcResponse<{ id: number }>({
      result: { data: { id: 42 } },
    });
    expect(out).toEqual({ id: 42 });
  });

  it("unwraps `result.data.json` (json-wrapped envelope)", () => {
    const out = parseTrpcResponse<{ id: number }>({
      result: { data: { json: { id: 42 } } },
    });
    expect(out).toEqual({ id: 42 });
  });

  it("throws ScheduleAddError on the error envelope", () => {
    let caught: ScheduleAddError | null = null;
    try {
      parseTrpcResponse({
        error: {
          message: "rate limited",
          data: { code: "TOO_MANY_REQUESTS" },
        },
      });
    } catch (e) {
      caught = e as ScheduleAddError;
    }
    expect(caught).toBeInstanceOf(ScheduleAddError);
    expect(caught!.code).toBe("TOO_MANY_REQUESTS");
    expect(caught!.message).toBe("rate limited");
  });

  it("falls back to INTERNAL_SERVER_ERROR when error.data.code is missing", () => {
    let caught: ScheduleAddError | null = null;
    try {
      parseTrpcResponse({ error: { message: "boom" } });
    } catch (e) {
      caught = e as ScheduleAddError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
