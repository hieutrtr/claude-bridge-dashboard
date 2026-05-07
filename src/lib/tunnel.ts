// P4-T08 — Pure helpers for the cloudflared tunnel runner. Extracted
// from `scripts/start.ts` so the argv parser, the refuse-to-start
// gates, and the trycloudflare URL detector can be unit-tested under
// Bun without spawning child processes.
//
// The script wrapper (`scripts/start.ts`) consumes these helpers and
// performs the side effects (spawning `next start` + `cloudflared
// tunnel`, signal forwarding, stderr scraping). The wrapper itself is
// intentionally NOT covered by unit tests — it's a 60-line glue shell
// over `child_process.spawn` and the integration is verified by hand
// per the T08 review checklist.
//
// Why two refuse-to-start gates (RESEND_API_KEY + DASHBOARD_PASSWORD):
// the tunnel exposes the dashboard to the public internet via
// `*.trycloudflare.com`. v1 ARCH §10 ("Public exposure misuse")
// requires (a) magic-link auth must be active so the auto-generated
// password fallback can't be brute-forced from a tunnel, and (b) the
// owner password must be non-default so a leaked default doesn't
// instantly grant access. The two gates encode that requirement at
// the script entry point — refuse-to-start, not warn-and-continue.

/** Default port the dashboard listens on. Matches v2 ARCH §7.4. */
export const DEFAULT_DASHBOARD_PORT = 7878;

/** Local address cloudflared forwards to. Loopback only — never bind 0.0.0.0. */
export const TUNNEL_LOCAL_HOST = "127.0.0.1";

/**
 * Minimum length the owner password must reach before the tunnel
 * agrees to start. 16 characters is the threshold from v1 ARCH §10
 * brute-force mitigation — at < 1 ms/attempt over a tunnel a 16-char
 * alphanumeric password takes >10^15 attempts to enumerate, well past
 * the cloudflared free-tier bandwidth ceiling.
 */
export const MIN_PASSWORD_LENGTH = 16;

/**
 * Sentinel default values that DASHBOARD_PASSWORD must NOT equal.
 * Anything matching one of these (case-insensitive trim) is treated
 * as a development placeholder and refused under tunnel.
 */
export const DEFAULT_PASSWORD_SENTINELS: ReadonlyArray<string> = [
  "password",
  "changeme",
  "change-me",
  "admin",
  "owner",
  "dashboard",
  "smoke-pass",
];

export interface ParsedStartArgs {
  /** True when `--tunnel` (or `--tunnel=cloudflared`) is present. */
  tunnel: boolean;
  /** Port for `next start -p <port>`; defaults to 7878. */
  port: number;
  /** Argv pass-through (everything except --tunnel and --port). */
  passthrough: string[];
}

/**
 * Parse the argv tail that bun forwards to `bun run start <args>`.
 *
 * Supported forms:
 *   --tunnel
 *   --tunnel=cloudflared          (only `cloudflared` accepted; we
 *                                  reject other providers explicitly)
 *   --port 9000
 *   --port=9000
 *   -p 9000                       (passthrough — `next start` handles it)
 *
 * Unknown flags are passed through to `next start` so the wrapper
 * stays compatible with future Next.js CLI options.
 */
export function parseStartArgs(argv: ReadonlyArray<string>): ParsedStartArgs {
  let tunnel = false;
  let port: number | null = null;
  const passthrough: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tunnel") {
      tunnel = true;
      continue;
    }
    if (arg.startsWith("--tunnel=")) {
      const value = arg.slice("--tunnel=".length).toLowerCase();
      if (value !== "cloudflared" && value !== "cloudflare" && value !== "") {
        throw new Error(
          `Unsupported tunnel provider "${value}" — only "cloudflared" is bundled. Drop the value or use --tunnel.`,
        );
      }
      tunnel = true;
      continue;
    }
    if (arg === "--port") {
      const next = argv[i + 1];
      const parsed = parsePort(next);
      if (parsed === null) {
        throw new Error(`--port requires a numeric value (got ${JSON.stringify(next)}).`);
      }
      port = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      const value = arg.slice("--port=".length);
      const parsed = parsePort(value);
      if (parsed === null) {
        throw new Error(`--port=<n> requires a numeric value (got ${JSON.stringify(value)}).`);
      }
      port = parsed;
      continue;
    }
    passthrough.push(arg);
  }

  return {
    tunnel,
    port: port ?? DEFAULT_DASHBOARD_PORT,
    passthrough,
  };
}

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > 65535) return null;
  return n;
}

export interface TunnelEnvValidation {
  ok: boolean;
  errors: ReadonlyArray<string>;
}

/**
 * Refuse-to-start gate enforced by `scripts/start.ts` BEFORE spawning
 * either `next start` or `cloudflared`. Returns ALL failures (do not
 * short-circuit) so the operator sees every blocker in one print.
 *
 * Required env (T08 review §1, §2):
 *   - RESEND_API_KEY              (magic-link must be reachable)
 *   - RESEND_FROM_EMAIL           (Resend rejects without a sender)
 *   - DASHBOARD_PASSWORD          (owner fallback must exist & be strong)
 */
export function validateTunnelEnv(
  env: Readonly<Record<string, string | undefined>>,
): TunnelEnvValidation {
  const errors: string[] = [];

  if (!env.RESEND_API_KEY || env.RESEND_API_KEY.trim().length === 0) {
    errors.push(
      "RESEND_API_KEY is not set — magic-link login would be disabled, leaving only the owner password exposed to the public tunnel. Set RESEND_API_KEY before starting with --tunnel.",
    );
  }

  if (!env.RESEND_FROM_EMAIL || env.RESEND_FROM_EMAIL.trim().length === 0) {
    errors.push(
      "RESEND_FROM_EMAIL is not set — Resend rejects requests without a verified sender. Set RESEND_FROM_EMAIL before starting with --tunnel.",
    );
  }

  const password = env.DASHBOARD_PASSWORD ?? "";
  if (password.length === 0) {
    errors.push(
      "DASHBOARD_PASSWORD is not set — refusing to expose an unauthenticated dashboard via tunnel.",
    );
  } else {
    if (password.length < MIN_PASSWORD_LENGTH) {
      errors.push(
        `DASHBOARD_PASSWORD is only ${password.length} characters — tunnel mode requires ≥ ${MIN_PASSWORD_LENGTH} (v1 ARCH §10 brute-force mitigation).`,
      );
    }
    if (isDefaultPassword(password)) {
      errors.push(
        "DASHBOARD_PASSWORD matches a known default placeholder — pick a unique password before starting with --tunnel.",
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/** True when `password` matches a sentinel default (case-insensitive trim). */
export function isDefaultPassword(password: string): boolean {
  const normalized = password.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return DEFAULT_PASSWORD_SENTINELS.some(
    (sentinel) => normalized === sentinel,
  );
}

const TRYCLOUDFLARE_URL_RE =
  /https?:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.trycloudflare\.com/;

/**
 * Scrape a single line of cloudflared stderr for the public
 * `*.trycloudflare.com` URL it prints once the tunnel is established.
 * Returns null when the line carries no URL — caller streams every
 * stderr line and stops scraping after the first match.
 *
 * Cloudflared's output format (as of cf v2024.1) places the URL on
 * its own line wrapped in vertical bars:
 *
 *   2024-01-...|  https://flat-roses-fix.trycloudflare.com  |
 *
 * The regex is intentionally loose on the surrounding chrome so a
 * future cf release that drops the bars still parses.
 */
export function extractTunnelUrl(line: string): string | null {
  const m = line.match(TRYCLOUDFLARE_URL_RE);
  return m ? m[0] : null;
}

export interface CloudflaredMissingHint {
  command: string;
  hint: string;
}

/** Per-platform install hint printed when `cloudflared` exec fails ENOENT. */
export function cloudflaredInstallHint(
  platform: NodeJS.Platform,
): CloudflaredMissingHint {
  switch (platform) {
    case "darwin":
      return {
        command: "brew install cloudflared",
        hint: "Install via Homebrew, then re-run `bun run start --tunnel`.",
      };
    case "linux":
      return {
        command:
          "curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared",
        hint: "Or use the deb/rpm package from https://pkg.cloudflare.com/.",
      };
    case "win32":
      return {
        command:
          "winget install --id Cloudflare.cloudflared",
        hint: "Or download the .msi from https://github.com/cloudflare/cloudflared/releases.",
      };
    default:
      return {
        command:
          "https://github.com/cloudflare/cloudflared/releases",
        hint: "Download the binary for your platform and place it on PATH.",
      };
  }
}
