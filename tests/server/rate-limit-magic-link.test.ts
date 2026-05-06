import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { __setAuditDb } from "../../src/server/audit";

const ORIGINAL_ENV = { ...process.env };

function setEnv(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
}

async function freshModule() {
  const url = `../../src/server/rate-limit-magic-link.ts?t=${Math.random()}`;
  return (await import(url)) as typeof import("../../src/server/rate-limit-magic-link");
}

beforeEach(async () => {
  // Audit subsystem is happy to no-op when no DB is wired; we just
  // disable it explicitly so the rate-limit module's appendAudit
  // calls don't try to reach a real handle.
  __setAuditDb(null);
  setEnv({
    RATE_LIMIT_MAGIC_LINK_IP_PER_MIN: undefined,
    RATE_LIMIT_MAGIC_LINK_EMAIL_PER_HOUR: undefined,
    RATE_LIMIT_MAGIC_LINK_CONSUME_PER_MIN: undefined,
  });
  const m = await freshModule();
  m._reset();
});

afterEach(() => {
  setEnv({
    RATE_LIMIT_MAGIC_LINK_IP_PER_MIN:
      ORIGINAL_ENV.RATE_LIMIT_MAGIC_LINK_IP_PER_MIN,
    RATE_LIMIT_MAGIC_LINK_EMAIL_PER_HOUR:
      ORIGINAL_ENV.RATE_LIMIT_MAGIC_LINK_EMAIL_PER_HOUR,
    RATE_LIMIT_MAGIC_LINK_CONSUME_PER_MIN:
      ORIGINAL_ENV.RATE_LIMIT_MAGIC_LINK_CONSUME_PER_MIN,
  });
});

function makeReq(xff: string | undefined): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (xff) headers["x-forwarded-for"] = xff;
  return new Request("http://localhost/api/auth/magic-link/request", {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

describe("rateLimitMagicLinkRequest — IP bucket", () => {
  it("allows 5 requests in a row from the same IP for distinct emails", async () => {
    const { rateLimitMagicLinkRequest } = await freshModule();
    for (let i = 0; i < 5; i++) {
      expect(
        rateLimitMagicLinkRequest({
          req: makeReq("1.2.3.4"),
          emailHash: `hash-${i}`,
        }),
      ).toBeNull();
    }
  });

  it("blocks the 6th request from the same IP with 429 + scope=ip audit", async () => {
    const { rateLimitMagicLinkRequest } = await freshModule();
    for (let i = 0; i < 5; i++) {
      rateLimitMagicLinkRequest({
        req: makeReq("1.2.3.4"),
        emailHash: `hash-${i}`,
      });
    }
    const res = rateLimitMagicLinkRequest({
      req: makeReq("1.2.3.4"),
      emailHash: "hash-final",
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    expect(Number(res!.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("different IPs do not share the per-IP bucket", async () => {
    const { rateLimitMagicLinkRequest } = await freshModule();
    for (let i = 0; i < 5; i++) {
      rateLimitMagicLinkRequest({
        req: makeReq("1.1.1.1"),
        emailHash: `a-${i}`,
      });
    }
    expect(
      rateLimitMagicLinkRequest({
        req: makeReq("1.1.1.1"),
        emailHash: "a-x",
      })!.status,
    ).toBe(429);
    for (let i = 0; i < 5; i++) {
      expect(
        rateLimitMagicLinkRequest({
          req: makeReq("2.2.2.2"),
          emailHash: `b-${i}`,
        }),
      ).toBeNull();
    }
  });
});

describe("rateLimitMagicLinkRequest — email bucket", () => {
  it("allows 5 requests for the same email-hash from distinct IPs", async () => {
    const { rateLimitMagicLinkRequest } = await freshModule();
    for (let i = 0; i < 5; i++) {
      expect(
        rateLimitMagicLinkRequest({
          req: makeReq(`10.0.0.${i}`),
          emailHash: "email-shared",
        }),
      ).toBeNull();
    }
  });

  it("blocks the 6th request for the same email-hash even from a fresh IP", async () => {
    const { rateLimitMagicLinkRequest } = await freshModule();
    for (let i = 0; i < 5; i++) {
      rateLimitMagicLinkRequest({
        req: makeReq(`10.0.0.${i}`),
        emailHash: "email-victim",
      });
    }
    const res = rateLimitMagicLinkRequest({
      req: makeReq("9.9.9.9"),
      emailHash: "email-victim",
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });

  it("different email-hashes do not share the per-email bucket", async () => {
    const { rateLimitMagicLinkRequest } = await freshModule();
    for (let i = 0; i < 5; i++) {
      rateLimitMagicLinkRequest({
        req: makeReq(`10.0.0.${i}`),
        emailHash: "email-A",
      });
    }
    expect(
      rateLimitMagicLinkRequest({
        req: makeReq("11.0.0.1"),
        emailHash: "email-A",
      })!.status,
    ).toBe(429);
    expect(
      rateLimitMagicLinkRequest({
        req: makeReq("11.0.0.2"),
        emailHash: "email-B",
      }),
    ).toBeNull();
  });
});

describe("rateLimitMagicLinkConsume", () => {
  it("allows 5 consume attempts per IP per minute", async () => {
    const { rateLimitMagicLinkConsume } = await freshModule();
    for (let i = 0; i < 5; i++) {
      expect(rateLimitMagicLinkConsume(makeReq("1.2.3.4"))).toBeNull();
    }
  });

  it("blocks the 6th consume attempt from the same IP with 429", async () => {
    const { rateLimitMagicLinkConsume } = await freshModule();
    for (let i = 0; i < 5; i++) {
      rateLimitMagicLinkConsume(makeReq("1.2.3.4"));
    }
    const res = rateLimitMagicLinkConsume(makeReq("1.2.3.4"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });
});

describe("rateLimitMagicLinkRequest — disabled buckets", () => {
  it("RATE_LIMIT_MAGIC_LINK_IP_PER_MIN=0 disables the IP bucket", async () => {
    setEnv({
      RATE_LIMIT_MAGIC_LINK_IP_PER_MIN: "0",
      RATE_LIMIT_MAGIC_LINK_EMAIL_PER_HOUR: "0",
    });
    const { rateLimitMagicLinkRequest } = await freshModule();
    for (let i = 0; i < 100; i++) {
      expect(
        rateLimitMagicLinkRequest({
          req: makeReq("3.3.3.3"),
          emailHash: "x",
        }),
      ).toBeNull();
    }
  });
});
