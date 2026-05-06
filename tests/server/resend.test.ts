import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  __setResendFetch,
  readResendConfig,
  sendMagicLinkEmail,
} from "../../src/server/resend";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  __setResendFetch(null);
  for (const k of ["RESEND_API_KEY", "RESEND_FROM_EMAIL"] as const) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k]!;
  }
});

describe("readResendConfig", () => {
  it("returns null when API key is missing", () => {
    expect(readResendConfig({ RESEND_FROM_EMAIL: "x@y.com" })).toBeNull();
  });

  it("returns null when from email is missing", () => {
    expect(readResendConfig({ RESEND_API_KEY: "k" })).toBeNull();
  });

  it("returns config when both are set", () => {
    expect(
      readResendConfig({ RESEND_API_KEY: "k", RESEND_FROM_EMAIL: "from@x.com" }),
    ).toEqual({ apiKey: "k", from: "from@x.com" });
  });

  it("treats empty strings as missing", () => {
    expect(
      readResendConfig({ RESEND_API_KEY: "", RESEND_FROM_EMAIL: "" }),
    ).toBeNull();
  });
});

describe("sendMagicLinkEmail — graceful failure", () => {
  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it("returns resend_not_configured when env is missing", async () => {
    const result = await sendMagicLinkEmail({
      to: "a@b.com",
      consumeUrl: "http://x/y",
      expiresAtIso: "2026-05-07T10:00:00Z",
    });
    expect(result).toEqual({ ok: false, reason: "resend_not_configured" });
  });

  it("does not call fetch when not configured", async () => {
    let calls = 0;
    __setResendFetch((async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    await sendMagicLinkEmail({
      to: "a@b.com",
      consumeUrl: "http://x/y",
      expiresAtIso: "2026-05-07T10:00:00Z",
    });
    expect(calls).toBe(0);
  });
});

describe("sendMagicLinkEmail — happy path", () => {
  it("POSTs to the Resend API with bearer auth + JSON body containing the URL", async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    __setResendFetch((async (url: string, init?: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ id: "msg_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const result = await sendMagicLinkEmail({
      to: "Hieu@Example.com",
      consumeUrl: "https://dash.local/api/auth/magic-link/consume?token=abc",
      expiresAtIso: "2026-05-07T10:00:00Z",
      config: { apiKey: "key-123", from: "noreply@x.com" },
    });
    expect(result).toEqual({ ok: true, status: 200, id: "msg_123" });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://api.resend.com/emails");
    const headers = captured!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer key-123");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(captured!.init!.body as string);
    expect(body.from).toBe("noreply@x.com");
    expect(body.to).toEqual(["hieu@example.com"]); // normalized
    expect(body.subject).toContain("Sign in");
    expect(body.html).toContain(
      "https://dash.local/api/auth/magic-link/consume?token=abc",
    );
    expect(body.text).toContain(
      "https://dash.local/api/auth/magic-link/consume?token=abc",
    );
  });
});

describe("sendMagicLinkEmail — error paths", () => {
  it("returns resend_error on non-2xx", async () => {
    __setResendFetch((async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch);
    const result = await sendMagicLinkEmail({
      to: "a@b.com",
      consumeUrl: "http://x",
      expiresAtIso: "iso",
      config: { apiKey: "k", from: "f@x.com" },
    });
    expect(result).toEqual({ ok: false, reason: "resend_error", status: 500 });
  });

  it("returns resend_network on thrown fetch", async () => {
    __setResendFetch((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    const result = await sendMagicLinkEmail({
      to: "a@b.com",
      consumeUrl: "http://x",
      expiresAtIso: "iso",
      config: { apiKey: "k", from: "f@x.com" },
    });
    expect(result).toEqual({ ok: false, reason: "resend_network" });
  });

  it("returns ok:true even when response body is malformed", async () => {
    __setResendFetch((async () =>
      new Response("not-json", { status: 200 })) as unknown as typeof fetch);
    const result = await sendMagicLinkEmail({
      to: "a@b.com",
      consumeUrl: "http://x",
      expiresAtIso: "iso",
      config: { apiKey: "k", from: "f@x.com" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.id).toBeUndefined();
  });
});
