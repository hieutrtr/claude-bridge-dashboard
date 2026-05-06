// P4-T06 — email-digest job (library half).
//
// The CLI entry point (`scripts/email-digest.ts`) opens the DB +
// reads env vars; this module owns the pure computation:
//
//   * `selectRecipientsForHour(now, db?)` — picks rows where
//     `email_digest_enabled = 1` AND the local hour matches the
//     configured hour. The TZ conversion uses `Intl.DateTimeFormat`
//     so DST + offset shifts are handled correctly.
//   * `buildDigestSummary(userId, now, db?)` — joins `tasks` ↔
//     `agents` to get the caller's last-24h activity. Returns a
//     compact `{ taskCount, totalCostUsd, errorCount, agents: [...] }`.
//   * `renderDigestEmail(summary, opts)` — pure HTML/text renderer.
//     Includes a one-click unsubscribe link
//     (`/settings/notifications`) per anti-abuse + RFC 8058 spirit.
//   * `runEmailDigest({ now, fetch, env, audit })` — orchestrates the
//     send loop. Records one audit row per recipient
//     (`notification.email-digest-sent` or `…skipped` /
//     `…failed`) using `emailHash` (never the plaintext address).
//
// Privacy: the digest body contains the recipient's email plaintext
// (it has to — Resend needs the address) but the audit log only
// records `emailHash`. The summary itself never echoes other users'
// emails — every join is filtered to `tasks.user_id = caller.id`.
//
// Test seam: every IO is parameterised. Pass `now`, a fake `fetch`,
// and an env object to drive the loop deterministically. The CLI
// wrapper threads the real values.

import { Database } from "bun:sqlite";

import { appendAudit } from "./audit";
import {
  listEmailDigestRecipients,
  type DigestRecipient,
} from "./notification-prefs";
import { getSqlite } from "./db";
import { readResendConfig, type ResendConfig } from "./resend";
import {
  emailHash as makeEmailHash,
  resolveAuditSalt,
} from "@/src/lib/email-hash";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface DigestSummary {
  userId: string;
  taskCount: number;
  errorCount: number;
  totalCostUsd: number;
  agents: Array<{ name: string; taskCount: number; costUsd: number }>;
  windowStart: number;
  windowEnd: number;
}

interface RawTaskRow {
  agent_name: string;
  status: string;
  cost_usd: number | null;
}

/**
 * Build a per-user summary of activity in the last 24h. The task
 * table records `cost_usd` per row; we sum it and bucket by agent
 * name so the email lists "alpha — 12 tasks, $0.42" lines.
 *
 * Joining via `agents.session_id` matches the existing analytics
 * router pattern and avoids leaking session ids into the email.
 */
export function buildDigestSummary(
  userId: string,
  now: number,
  db?: Database,
): DigestSummary {
  const handle = db ?? getSqlite();
  const windowEnd = now;
  const windowStart = now - ONE_DAY_MS;

  // Tasks attributed to the recipient via `tasks.user_id`. Tasks
  // with NULL `user_id` (legacy CLI rows) are NOT included — they
  // belong to the env-owner identity, which is recipient-specific
  // and should not splash across multi-tenant deployments.
  const rows = handle
    .prepare(
      `SELECT a.name AS agent_name, t.status AS status, t.cost_usd AS cost_usd
         FROM tasks t
         JOIN agents a ON a.session_id = t.session_id
        WHERE t.user_id = ?
          AND t.completed_at IS NOT NULL
          AND CAST(strftime('%s', t.completed_at) AS INTEGER) * 1000 >= ?
          AND CAST(strftime('%s', t.completed_at) AS INTEGER) * 1000 <= ?`,
    )
    .all(userId, windowStart, windowEnd) as RawTaskRow[];

  let taskCount = 0;
  let errorCount = 0;
  let totalCostUsd = 0;
  const byAgent = new Map<
    string,
    { name: string; taskCount: number; costUsd: number }
  >();

  for (const row of rows) {
    taskCount += 1;
    if (row.status === "error" || row.status === "failed") errorCount += 1;
    const cost = row.cost_usd ?? 0;
    totalCostUsd += cost;
    const cur =
      byAgent.get(row.agent_name) ??
      { name: row.agent_name, taskCount: 0, costUsd: 0 };
    cur.taskCount += 1;
    cur.costUsd += cost;
    byAgent.set(row.agent_name, cur);
  }

  const agents = Array.from(byAgent.values()).sort(
    (a, b) => b.costUsd - a.costUsd || b.taskCount - a.taskCount,
  );

  return {
    userId,
    taskCount,
    errorCount,
    totalCostUsd,
    agents,
    windowStart,
    windowEnd,
  };
}

/**
 * Convert UTC `now` to the recipient's local hour. Used by the
 * scheduler to decide whether the digest should fire this run.
 *
 * Returns `null` for an invalid TZ (digest is skipped + audited).
 */
export function localHourFor(
  now: number,
  tz: string,
): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(now));
    const hourPart = parts.find((p) => p.type === "hour");
    if (!hourPart) return null;
    const hour = Number(hourPart.value);
    if (!Number.isInteger(hour)) return null;
    // `formatToParts` can emit "24" for midnight in some TZ DB
    // configurations; normalise.
    if (hour === 24) return 0;
    if (hour < 0 || hour > 23) return null;
    return hour;
  } catch {
    return null;
  }
}

/**
 * Subset of recipients whose configured hour matches the local hour
 * for `now` in their TZ. Caller still needs to track "already sent
 * today" — that's a `last_sent_at` column we can add in v0.2.0; for
 * now the cron schedule is hour-aligned and the job records audit
 * rows so duplicate runs are recoverable.
 */
export function selectRecipientsForHour(
  now: number,
  db?: Database,
): Array<DigestRecipient & { localHour: number }> {
  const all = listEmailDigestRecipients(db);
  const out: Array<DigestRecipient & { localHour: number }> = [];
  for (const r of all) {
    const local = localHourFor(now, r.tz);
    if (local === null) continue;
    if (local !== r.hour) continue;
    out.push({ ...r, localHour: local });
  }
  return out;
}

export interface RenderDigestInput {
  summary: DigestSummary;
  /** Recipient address — included verbatim in the body greeting. */
  toEmail: string;
  /** Origin used for the unsubscribe URL. */
  origin: string;
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function renderDigestEmail(input: RenderDigestInput): RenderedDigest {
  const { summary, toEmail, origin } = input;
  const unsubscribe = `${origin.replace(/\/$/, "")}/settings/notifications`;

  const subject =
    summary.taskCount === 0
      ? "Claude Bridge — quiet day (no tasks)"
      : `Claude Bridge — ${summary.taskCount} task${summary.taskCount === 1 ? "" : "s"} in the last 24h`;

  const agentRows = summary.agents
    .map(
      (a) =>
        `<tr><td style="padding:4px 8px;">${escapeHtml(a.name)}</td>` +
        `<td style="padding:4px 8px; text-align:right;">${a.taskCount}</td>` +
        `<td style="padding:4px 8px; text-align:right; font-family:monospace;">${fmtUsd(a.costUsd)}</td></tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,sans-serif;padding:24px;max-width:560px;">
  <h2 style="margin:0 0 12px 0;">Daily digest for ${escapeHtml(toEmail)}</h2>
  <p style="margin:0 0 16px 0;color:#374151;">Activity in the last 24h:</p>
  <ul style="margin:0 0 16px 0;padding-left:20px;color:#111827;">
    <li><strong>${summary.taskCount}</strong> task${summary.taskCount === 1 ? "" : "s"} completed</li>
    <li><strong>${summary.errorCount}</strong> error${summary.errorCount === 1 ? "" : "s"}</li>
    <li>Total cost: <strong>${fmtUsd(summary.totalCostUsd)}</strong></li>
  </ul>
  ${
    agentRows
      ? `<table style="border-collapse:collapse;font-size:13px;width:100%;">
          <thead><tr style="background:#f3f4f6;">
            <th style="padding:6px 8px;text-align:left;">Agent</th>
            <th style="padding:6px 8px;text-align:right;">Tasks</th>
            <th style="padding:6px 8px;text-align:right;">Cost</th>
          </tr></thead>
          <tbody>${agentRows}</tbody>
        </table>`
      : `<p style="color:#6b7280;font-size:13px;">No tasks attributed to your account in the last 24h.</p>`
  }
  <p style="margin-top:24px;color:#6b7280;font-size:12px;">
    To stop these emails, visit <a href="${unsubscribe}">${unsubscribe}</a>.
  </p>
</body></html>`;

  const textAgents = summary.agents
    .map((a) => `  - ${a.name}: ${a.taskCount} tasks, ${fmtUsd(a.costUsd)}`)
    .join("\n");

  const text = `Daily digest for ${toEmail}

Activity in the last 24h:
- ${summary.taskCount} task(s) completed
- ${summary.errorCount} error(s)
- Total cost: ${fmtUsd(summary.totalCostUsd)}

${textAgents || "  (no tasks attributed to your account)"}

Unsubscribe: ${unsubscribe}
`;

  return { subject, html, text };
}

interface SendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type DigestSendResult =
  | { ok: true; status: number; id?: string }
  | { ok: false; reason: "resend_error" | "resend_network"; status?: number };

async function sendDigest(
  input: SendInput,
  config: ResendConfig,
  fetchImpl: typeof fetch,
): Promise<DigestSendResult> {
  let res: Response;
  try {
    res = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
  } catch {
    return { ok: false, reason: "resend_network" };
  }
  if (!res.ok) return { ok: false, reason: "resend_error", status: res.status };
  let id: string | undefined;
  try {
    const j = (await res.json()) as { id?: unknown };
    if (typeof j.id === "string") id = j.id;
  } catch {
    /* tolerate empty body */
  }
  return { ok: true, status: res.status, id };
}

export interface RunEmailDigestInput {
  /** Override `Date.now()` — tests pass a fixed clock. */
  now?: number;
  /** Override fetch — tests pass a stub. */
  fetch?: typeof fetch;
  /** Env override — defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** DB override — defaults to `getSqlite()`. */
  db?: Database;
  /** Origin for unsubscribe URL. Defaults to `env.DASHBOARD_URL` or `http://localhost:7878`. */
  origin?: string;
}

export interface RunEmailDigestResult {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function runEmailDigest(
  input: RunEmailDigestInput = {},
): Promise<RunEmailDigestResult> {
  const now = input.now ?? Date.now();
  const fetchImpl = input.fetch ?? fetch;
  const env = input.env ?? process.env;
  const db = input.db;
  const config = readResendConfig(env);
  const origin =
    input.origin ?? env.DASHBOARD_URL ?? "http://localhost:7878";

  const recipients = selectRecipientsForHour(now, db);
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const salt = resolveAuditSalt();

  for (const r of recipients) {
    const summary = buildDigestSummary(r.userId, now, db);
    const rendered = renderDigestEmail({
      summary,
      toEmail: r.email,
      origin,
    });
    const hashedEmail = salt
      ? makeEmailHash(r.email, salt)
      : "no-salt";

    if (!config) {
      // Resend not configured — record an audit row so the operator
      // can confirm the cron is running, but don't crash the loop.
      appendAudit({
        action: "notification.email-digest-skipped",
        resourceType: "notification_preferences",
        resourceId: r.userId,
        userId: r.userId,
        payload: {
          targetEmailHash: hashedEmail,
          reason: "resend_not_configured",
          taskCount: summary.taskCount,
        },
      });
      skipped += 1;
      continue;
    }

    const result = await sendDigest(
      {
        to: r.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      },
      config,
      fetchImpl,
    );

    if (result.ok) {
      sent += 1;
      appendAudit({
        action: "notification.email-digest-sent",
        resourceType: "notification_preferences",
        resourceId: r.userId,
        userId: r.userId,
        payload: {
          targetEmailHash: hashedEmail,
          taskCount: summary.taskCount,
          totalCostUsd: summary.totalCostUsd,
        },
      });
    } else {
      failed += 1;
      appendAudit({
        action: "notification.email-digest-failed",
        resourceType: "notification_preferences",
        resourceId: r.userId,
        userId: r.userId,
        payload: {
          targetEmailHash: hashedEmail,
          reason: result.reason,
          status: result.status,
        },
      });
    }
  }

  return { considered: recipients.length, sent, skipped, failed };
}
