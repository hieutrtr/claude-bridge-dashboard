// P4-T08 — Pure-helper tests for the cloudflared tunnel start
// wrapper. The script `scripts/start.ts` itself is a side-effect shell
// (spawns child processes, wires signals) and is verified manually per
// the T08 review checklist; everything testable lives in
// `src/lib/tunnel.ts`.

import { describe, it, expect } from "bun:test";

import {
  cloudflaredInstallHint,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_PASSWORD_SENTINELS,
  extractTunnelUrl,
  isDefaultPassword,
  MIN_PASSWORD_LENGTH,
  parseStartArgs,
  TUNNEL_LOCAL_HOST,
  validateTunnelEnv,
} from "../../src/lib/tunnel";

describe("parseStartArgs", () => {
  it("returns tunnel=false and the default port for an empty argv", () => {
    const result = parseStartArgs([]);
    expect(result.tunnel).toBe(false);
    expect(result.port).toBe(DEFAULT_DASHBOARD_PORT);
    expect(result.passthrough).toEqual([]);
  });

  it("flips tunnel=true when --tunnel is present", () => {
    const result = parseStartArgs(["--tunnel"]);
    expect(result.tunnel).toBe(true);
  });

  it("accepts --tunnel=cloudflared (and the cloudflare alias)", () => {
    expect(parseStartArgs(["--tunnel=cloudflared"]).tunnel).toBe(true);
    expect(parseStartArgs(["--tunnel=cloudflare"]).tunnel).toBe(true);
    expect(parseStartArgs(["--tunnel="]).tunnel).toBe(true);
  });

  it("rejects unsupported tunnel providers loudly", () => {
    expect(() => parseStartArgs(["--tunnel=ngrok"])).toThrow(
      /Unsupported tunnel provider "ngrok"/,
    );
  });

  it("parses --port 9000 and --port=9000 to the same number", () => {
    expect(parseStartArgs(["--port", "9000"]).port).toBe(9000);
    expect(parseStartArgs(["--port=9000"]).port).toBe(9000);
  });

  it("rejects a non-numeric --port value", () => {
    expect(() => parseStartArgs(["--port", "abc"])).toThrow(/numeric value/);
    expect(() => parseStartArgs(["--port="])).toThrow(/numeric value/);
  });

  it("rejects out-of-range ports", () => {
    expect(() => parseStartArgs(["--port", "0"])).toThrow();
    expect(() => parseStartArgs(["--port", "70000"])).toThrow();
  });

  it("forwards unknown flags so they reach next start", () => {
    const result = parseStartArgs(["--tunnel", "-H", "0.0.0.0", "--keepAliveTimeout", "100"]);
    expect(result.tunnel).toBe(true);
    expect(result.passthrough).toEqual(["-H", "0.0.0.0", "--keepAliveTimeout", "100"]);
  });

  it("combines --tunnel and --port in any order", () => {
    const a = parseStartArgs(["--tunnel", "--port", "8080"]);
    const b = parseStartArgs(["--port=8080", "--tunnel"]);
    expect(a).toEqual({ tunnel: true, port: 8080, passthrough: [] });
    expect(b).toEqual({ tunnel: true, port: 8080, passthrough: [] });
  });

  it("does NOT auto-enable tunnel when --tunnel is missing", () => {
    expect(parseStartArgs(["--port", "9000"]).tunnel).toBe(false);
  });
});

describe("validateTunnelEnv", () => {
  const goodEnv = {
    RESEND_API_KEY: "re_live_abc123",
    RESEND_FROM_EMAIL: "no-reply@example.com",
    DASHBOARD_PASSWORD: "a-strong-and-long-passphrase-2026",
  } as const;

  it("returns ok=true with no errors when every gate passes", () => {
    const result = validateTunnelEnv({ ...goodEnv });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags missing RESEND_API_KEY", () => {
    const result = validateTunnelEnv({ ...goodEnv, RESEND_API_KEY: "" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("RESEND_API_KEY"))).toBe(true);
  });

  it("flags missing RESEND_FROM_EMAIL", () => {
    const result = validateTunnelEnv({ ...goodEnv, RESEND_FROM_EMAIL: undefined });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("RESEND_FROM_EMAIL"))).toBe(true);
  });

  it("flags missing DASHBOARD_PASSWORD distinctly from a weak one", () => {
    const missing = validateTunnelEnv({ ...goodEnv, DASHBOARD_PASSWORD: "" });
    expect(missing.ok).toBe(false);
    expect(missing.errors.some((e) => e.includes("DASHBOARD_PASSWORD is not set"))).toBe(true);
    expect(missing.errors.some((e) => e.includes("characters"))).toBe(false);
  });

  it("flags a DASHBOARD_PASSWORD shorter than the minimum", () => {
    const result = validateTunnelEnv({
      ...goodEnv,
      DASHBOARD_PASSWORD: "short-1234",
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes(`requires ≥ ${MIN_PASSWORD_LENGTH}`),
      ),
    ).toBe(true);
  });

  it("flags a DASHBOARD_PASSWORD that matches a default sentinel", () => {
    for (const sentinel of DEFAULT_PASSWORD_SENTINELS) {
      const padded = sentinel.padEnd(MIN_PASSWORD_LENGTH + 4, "x");
      // Plain sentinel (will fail length OR sentinel rule depending on length).
      const result = validateTunnelEnv({
        ...goodEnv,
        DASHBOARD_PASSWORD: sentinel,
      });
      expect(result.ok).toBe(false);
      // Padded version: long enough but still flagged because the
      // bare sentinel is in the list. We just confirm the sentinel
      // detector itself fires for the bare value.
      expect(isDefaultPassword(sentinel)).toBe(true);
      expect(isDefaultPassword(padded)).toBe(false);
    }
  });

  it("returns ALL failures (does not short-circuit)", () => {
    const result = validateTunnelEnv({
      RESEND_API_KEY: "",
      RESEND_FROM_EMAIL: "",
      DASHBOARD_PASSWORD: "",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("MIN_PASSWORD_LENGTH is 16 (v1 ARCH §10 floor)", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(16);
  });
});

describe("isDefaultPassword", () => {
  it("matches sentinels case-insensitively after trim", () => {
    expect(isDefaultPassword("password")).toBe(true);
    expect(isDefaultPassword("  PASSWORD  ")).toBe(true);
    expect(isDefaultPassword("ChangeMe")).toBe(true);
    expect(isDefaultPassword("smoke-pass")).toBe(true);
  });

  it("returns false for a unique strong passphrase", () => {
    expect(isDefaultPassword("aurora-blue-typhoon-9817")).toBe(false);
    expect(isDefaultPassword("Tr0ub4dor-and-3-Horses")).toBe(false);
  });

  it("returns false for an empty string (caller flags that separately)", () => {
    expect(isDefaultPassword("")).toBe(false);
    expect(isDefaultPassword("   ")).toBe(false);
  });
});

describe("extractTunnelUrl", () => {
  it("plucks the URL from a typical cloudflared stderr line", () => {
    const line =
      "2024-01-15T08:14:22Z INF |  https://flat-roses-fix.trycloudflare.com  |";
    expect(extractTunnelUrl(line)).toBe(
      "https://flat-roses-fix.trycloudflare.com",
    );
  });

  it("matches an https URL even without the surrounding bars", () => {
    expect(
      extractTunnelUrl("Tunnel ready at https://abc-def-ghi.trycloudflare.com today."),
    ).toBe("https://abc-def-ghi.trycloudflare.com");
  });

  it("matches subdomains with hyphens and digits", () => {
    expect(
      extractTunnelUrl("https://sub-domain-123.trycloudflare.com"),
    ).toBe("https://sub-domain-123.trycloudflare.com");
  });

  it("returns null when no trycloudflare URL is present", () => {
    expect(extractTunnelUrl("INF connection established")).toBeNull();
    expect(extractTunnelUrl("")).toBeNull();
    // We do NOT scrape arbitrary cloudflare.com URLs (e.g.
    // dash.cloudflare.com) — only the ephemeral trycloudflare.com host.
    expect(extractTunnelUrl("https://dash.cloudflare.com/login")).toBeNull();
  });
});

describe("cloudflaredInstallHint", () => {
  it("returns the brew command on macOS", () => {
    const hint = cloudflaredInstallHint("darwin");
    expect(hint.command).toContain("brew install cloudflared");
    expect(hint.hint).toMatch(/Homebrew/);
  });

  it("returns a curl/deb pointer on linux", () => {
    const hint = cloudflaredInstallHint("linux");
    expect(hint.command).toMatch(/cloudflared/);
    expect(hint.hint).toMatch(/pkg\.cloudflare\.com|deb|rpm/);
  });

  it("returns the winget command on win32", () => {
    const hint = cloudflaredInstallHint("win32");
    expect(hint.command).toContain("winget install");
    expect(hint.hint).toMatch(/\.msi|releases/);
  });

  it("falls back to a generic releases URL on other platforms", () => {
    const hint = cloudflaredInstallHint("freebsd");
    expect(hint.command).toContain("github.com/cloudflare/cloudflared");
  });
});

describe("constants", () => {
  it("DEFAULT_DASHBOARD_PORT is 7878 (v2 ARCH §7.4)", () => {
    expect(DEFAULT_DASHBOARD_PORT).toBe(7878);
  });
  it("TUNNEL_LOCAL_HOST is loopback only", () => {
    expect(TUNNEL_LOCAL_HOST).toBe("127.0.0.1");
  });
});
