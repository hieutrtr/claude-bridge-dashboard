// P4-T01 — minimal Resend HTTP client.
//
// Graceful-fail contract (per Phase 4 INDEX env-var matrix):
//   - When `RESEND_API_KEY` or `RESEND_FROM_EMAIL` is unset, the
//     `sendMagicLinkEmail` helper short-circuits with `{ ok:false,
//     reason:"resend_not_configured" }` so the auth route can record
//     the audit row but still return 200 (privacy: response shape
//     does not leak whether email was actually sent).
//   - HTTP errors (network, 4xx, 5xx) are caught and surfaced as
//     `{ ok:false, reason:"resend_error", status }` for the same
//     reason. The audit log records the failure scope but the user-
//     -visible response is identical to a successful send.
//
// We POST directly to the public Resend HTTP API rather than pulling
// the official SDK so the dashboard ships zero new dependencies
// (T01 risk-budget: avoid an additional supply-chain surface for a
// task that's gated by a single optional env var).
//
// Test seam — `__setResendFetch` lets tests inject a fake fetch so the
// auth router tests can assert the request shape without a network
// round-trip. By default the helper uses globalThis.fetch.

import { normalizeEmail } from "@/src/lib/email-hash";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendConfig {
  apiKey: string;
  from: string;
}

export type ResendSendResult =
  | { ok: true; status: number; id?: string }
  | {
      ok: false;
      reason: "resend_not_configured" | "resend_error" | "resend_network";
      status?: number;
    };

type FetchLike = typeof fetch;

let __resendFetch: FetchLike | null = null;

export function __setResendFetch(fn: FetchLike | null): void {
  __resendFetch = fn;
}

export function readResendConfig(
  env: Record<string, string | undefined> = process.env,
): ResendConfig | null {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  if (!apiKey || apiKey.length === 0) return null;
  if (!from || from.length === 0) return null;
  return { apiKey, from };
}

export interface SendMagicLinkEmailInput {
  /** Plaintext recipient address. Lowercase + trim is applied. */
  to: string;
  /** Fully-qualified consume URL — e.g. `https://host/api/auth/magic-link/consume?token=...`. */
  consumeUrl: string;
  /** When the token expires, in ISO 8601 UTC for the email body. */
  expiresAtIso: string;
  /** Override config — used by tests; default reads from env. */
  config?: ResendConfig | null;
}

function renderHtml(consumeUrl: string, expiresAtIso: string): string {
  // Plain HTML, no templating dep. The button is a styled `<a>` so the
  // email renders identically across major clients without inlining a
  // CSS pipeline.
  return `<!DOCTYPE html>
<html><body style="font-family: -apple-system, sans-serif; padding: 24px; max-width: 480px;">
  <h2 style="margin: 0 0 12px 0;">Sign in to Claude Bridge</h2>
  <p>Click the button below to finish signing in. The link expires at <strong>${expiresAtIso}</strong> (UTC) and can be used only once.</p>
  <p><a href="${consumeUrl}" style="display: inline-block; background: #111827; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Sign in</a></p>
  <p style="font-size: 12px; color: #6b7280; word-break: break-all;">If the button doesn't work, paste this URL into your browser:<br><code>${consumeUrl}</code></p>
  <p style="font-size: 12px; color: #6b7280;">If you didn't request this email, you can safely ignore it.</p>
</body></html>`;
}

function renderText(consumeUrl: string, expiresAtIso: string): string {
  return `Sign in to Claude Bridge\n\nUse the link below to finish signing in. It expires at ${expiresAtIso} (UTC) and can be used only once.\n\n${consumeUrl}\n\nIf you didn't request this email, you can safely ignore it.\n`;
}

export async function sendMagicLinkEmail(
  input: SendMagicLinkEmailInput,
): Promise<ResendSendResult> {
  const config = input.config === undefined ? readResendConfig() : input.config;
  if (!config) return { ok: false, reason: "resend_not_configured" };

  const fetchImpl: FetchLike = __resendFetch ?? fetch;

  const body = JSON.stringify({
    from: config.from,
    to: [normalizeEmail(input.to)],
    subject: "Sign in to Claude Bridge",
    html: renderHtml(input.consumeUrl, input.expiresAtIso),
    text: renderText(input.consumeUrl, input.expiresAtIso),
  });

  let res: Response;
  try {
    res = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
    });
  } catch {
    return { ok: false, reason: "resend_network" };
  }

  if (!res.ok) {
    return { ok: false, reason: "resend_error", status: res.status };
  }

  let id: string | undefined;
  try {
    const json = (await res.json()) as { id?: unknown };
    if (typeof json.id === "string") id = json.id;
  } catch {
    // Resend documents a JSON body, but a missing/garbled body should
    // not turn a 200 into an error — the email already shipped.
  }
  return { ok: true, status: res.status, id };
}
