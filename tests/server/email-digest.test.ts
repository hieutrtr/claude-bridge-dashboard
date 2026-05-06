// P4-T06 — `src/server/email-digest.ts` tests.
//
// Coverage:
//   * `localHourFor` — TZ conversion across UTC, Asia/Saigon (+7),
//     America/Los_Angeles (-7/-8), and an invalid TZ returning null.
//   * `selectRecipientsForHour` — picks rows where `local hour ==
//     configured hour`, skips disabled rows, skips revoked users.
//   * `buildDigestSummary` — joins tasks ↔ agents, filters by user_id,
//     respects 24h window, aggregates per-agent + total cost.
//   * `renderDigestEmail` — HTML escapes the recipient + agent name,
//     contains the unsubscribe URL, subject toggles between
//     "quiet day" + "N task(s)".
//   * `runEmailDigest` — fakes Resend HTTP, asserts:
//       - audit row per recipient (sent / skipped / failed)
//       - email plaintext is NEVER recorded — payload uses
//         `targetEmailHash` only.
//       - `resend_not_configured` short-circuits with `skipped` audit.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDigestSummary,
  localHourFor,
  renderDigestEmail,
  runEmailDigest,
  selectRecipientsForHour,
} from "../../src/server/email-digest";
import { resetDb, getSqlite } from "../../src/server/db";
import { __resetAudit, __setAuditDb } from "../../src/server/audit";

const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  process.env.JWT_SECRET = "digest-test-secret";
  process.env.AUDIT_IP_HASH_SALT = "digest-test-salt";
  tmpDir = mkdtempSync(join(tmpdir(), "email-digest-test-"));
  dbPath = join(tmpDir, "bridge.db");
  process.env.BRIDGE_DB = dbPath;
  resetDb();
  db = getSqlite();
  // `tasks` + `agents` tables are owned by the daemon and not part of
  // the dashboard migrations. Create them manually here so the digest
  // join can run.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_file TEXT NOT NULL,
      purpose TEXT,
      state TEXT DEFAULT 'created',
      created_at NUMERIC DEFAULT CURRENT_TIMESTAMP,
      last_task_at NUMERIC,
      total_tasks INTEGER DEFAULT 0,
      model TEXT DEFAULT 'sonnet',
      PRIMARY KEY (name, project_dir)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      cost_usd REAL,
      created_at NUMERIC DEFAULT CURRENT_TIMESTAMP,
      completed_at NUMERIC,
      user_id TEXT
    );
  `);
  __resetAudit();
  __setAuditDb(db);
});

afterEach(() => {
  __setAuditDb(null);
  __resetAudit();
  resetDb();
  rmSync(tmpDir, { recursive: true, force: true });
  for (const key of [
    "JWT_SECRET",
    "AUDIT_IP_HASH_SALT",
    "BRIDGE_DB",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
    "DASHBOARD_URL",
  ] as const) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key]!;
  }
});

function seedUser(opts: {
  id: string;
  email: string;
  role?: "owner" | "member";
  revokedAt?: number | null;
}): void {
  db.prepare(
    `INSERT INTO users (id, email, role, created_at, last_login_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.email,
    opts.role ?? "member",
    Date.now(),
    null,
    opts.revokedAt ?? null,
  );
}

function seedPrefs(opts: {
  userId: string;
  emailDigestEnabled?: boolean;
  hour?: number;
  tz?: string;
}): void {
  db.prepare(
    `INSERT INTO notification_preferences
       (user_id, in_app_enabled, email_digest_enabled,
        email_digest_hour, email_digest_tz, browser_push_enabled,
        updated_at)
     VALUES (?, 1, ?, ?, ?, 0, ?)`,
  ).run(
    opts.userId,
    opts.emailDigestEnabled ? 1 : 0,
    opts.hour ?? 9,
    opts.tz ?? "UTC",
    Date.now(),
  );
}

function seedAgent(name: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO agents (name, project_dir, session_id, agent_file)
     VALUES (?, ?, ?, ?)`,
  ).run(name, `/tmp/${name}`, sessionId, `/tmp/${name}.md`);
}

function seedTask(opts: {
  sessionId: string;
  userId: string | null;
  status?: string;
  costUsd?: number;
  /** ISO timestamp of completion. */
  completedAt?: string | null;
}): void {
  db.prepare(
    `INSERT INTO tasks
       (session_id, prompt, status, cost_usd, created_at, completed_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.sessionId,
    "do thing",
    opts.status ?? "done",
    opts.costUsd ?? 0,
    opts.completedAt ?? "2026-05-05 09:00:00",
    opts.completedAt ?? null,
    opts.userId,
  );
}

interface AuditRow {
  action: string;
  resource_type: string;
  resource_id: string | null;
  user_id: string | null;
  payload_json: string | null;
}

function readAudit(action?: string): AuditRow[] {
  if (action) {
    return db
      .prepare(
        `SELECT action, resource_type, resource_id, user_id, payload_json
           FROM audit_log WHERE action = ? ORDER BY id ASC`,
      )
      .all(action) as AuditRow[];
  }
  return db
    .prepare(
      `SELECT action, resource_type, resource_id, user_id, payload_json
         FROM audit_log ORDER BY id ASC`,
    )
    .all() as AuditRow[];
}

describe("localHourFor", () => {
  // 2026-05-07 06:30:00 UTC. Sai Gon = UTC+7 → 13. LA in May = UTC-7 (PDT) → 23 prior day.
  const NOW = Date.UTC(2026, 4, 7, 6, 30, 0);

  it("returns the UTC hour for UTC", () => {
    expect(localHourFor(NOW, "UTC")).toBe(6);
  });

  it("converts Asia/Saigon (+7)", () => {
    expect(localHourFor(NOW, "Asia/Saigon")).toBe(13);
  });

  it("converts America/Los_Angeles (DST: PDT -7)", () => {
    expect(localHourFor(NOW, "America/Los_Angeles")).toBe(23);
  });

  it("returns null for an invalid TZ", () => {
    expect(localHourFor(NOW, "Not/A_TZ_String")).toBe(null);
  });
});

describe("selectRecipientsForHour", () => {
  it("returns rows where local hour matches configured hour", () => {
    const NOW = Date.UTC(2026, 4, 7, 6, 30, 0);
    seedUser({ id: "u-utc", email: "utc@example.com" });
    seedUser({ id: "u-vn", email: "vn@example.com" });
    seedUser({ id: "u-la", email: "la@example.com" });
    seedPrefs({
      userId: "u-utc",
      emailDigestEnabled: true,
      hour: 6,
      tz: "UTC",
    });
    seedPrefs({
      userId: "u-vn",
      emailDigestEnabled: true,
      hour: 13,
      tz: "Asia/Saigon",
    });
    seedPrefs({
      userId: "u-la",
      emailDigestEnabled: true,
      hour: 6, // not 23 — should be filtered out
      tz: "America/Los_Angeles",
    });
    const rows = selectRecipientsForHour(NOW, db);
    const ids = rows.map((r) => r.userId).sort();
    expect(ids).toEqual(["u-utc", "u-vn"]);
  });

  it("skips revoked users + disabled prefs", () => {
    const NOW = Date.UTC(2026, 4, 7, 9, 0, 0);
    seedUser({
      id: "u-rev",
      email: "rev@example.com",
      revokedAt: Date.now(),
    });
    seedUser({ id: "u-off", email: "off@example.com" });
    seedPrefs({
      userId: "u-rev",
      emailDigestEnabled: true,
      hour: 9,
      tz: "UTC",
    });
    seedPrefs({
      userId: "u-off",
      emailDigestEnabled: false,
      hour: 9,
      tz: "UTC",
    });
    expect(selectRecipientsForHour(NOW, db).length).toBe(0);
  });
});

describe("buildDigestSummary", () => {
  beforeEach(() => {
    seedUser({ id: "u1", email: "alice@example.com" });
    seedAgent("alpha", "s-alpha");
    seedAgent("beta", "s-beta");
  });

  it("aggregates last-24h tasks for the recipient", () => {
    const now = Date.UTC(2026, 4, 7, 12, 0, 0);
    const yesterday = "2026-05-06 12:00:00"; // 24h-ish ago, within window
    const earlier = "2026-05-05 12:00:00"; // outside 24h window

    seedTask({
      sessionId: "s-alpha",
      userId: "u1",
      costUsd: 0.5,
      status: "done",
      completedAt: yesterday,
    });
    seedTask({
      sessionId: "s-alpha",
      userId: "u1",
      costUsd: 0.25,
      status: "error",
      completedAt: yesterday,
    });
    seedTask({
      sessionId: "s-beta",
      userId: "u1",
      costUsd: 0.1,
      status: "done",
      completedAt: yesterday,
    });
    seedTask({
      sessionId: "s-alpha",
      userId: "u1",
      costUsd: 99.9,
      status: "done",
      completedAt: earlier,
    });
    seedTask({
      sessionId: "s-alpha",
      userId: "u-other",
      costUsd: 5.0,
      status: "done",
      completedAt: yesterday,
    });

    const summary = buildDigestSummary("u1", now, db);
    expect(summary.userId).toBe("u1");
    expect(summary.taskCount).toBe(3);
    expect(summary.errorCount).toBe(1);
    expect(summary.totalCostUsd).toBeCloseTo(0.85, 6);
    expect(summary.agents.length).toBe(2);
    expect(summary.agents[0]!.name).toBe("alpha"); // higher cost first
    expect(summary.agents[0]!.taskCount).toBe(2);
    expect(summary.agents[0]!.costUsd).toBeCloseTo(0.75, 6);
    expect(summary.agents[1]!.name).toBe("beta");
  });

  it("excludes tasks with NULL user_id (legacy carve-out)", () => {
    const now = Date.UTC(2026, 4, 7, 12, 0, 0);
    seedTask({
      sessionId: "s-alpha",
      userId: null,
      costUsd: 1.0,
      status: "done",
      completedAt: "2026-05-06 23:59:59",
    });
    const summary = buildDigestSummary("u1", now, db);
    expect(summary.taskCount).toBe(0);
  });
});

describe("renderDigestEmail", () => {
  it("HTML-escapes the recipient + agent name", () => {
    const rendered = renderDigestEmail({
      summary: {
        userId: "u1",
        taskCount: 1,
        errorCount: 0,
        totalCostUsd: 1.5,
        agents: [
          { name: "<script>alert('x')</script>", taskCount: 1, costUsd: 1.5 },
        ],
        windowStart: 0,
        windowEnd: 0,
      },
      toEmail: "alice+bob@example.com",
      origin: "https://dash.example.com",
    });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("alice+bob@example.com");
    expect(rendered.html).toContain(
      "https://dash.example.com/settings/notifications",
    );
  });

  it("subject toggles between quiet/active days", () => {
    const base = {
      userId: "u1",
      errorCount: 0,
      totalCostUsd: 0,
      agents: [],
      windowStart: 0,
      windowEnd: 0,
    };
    expect(
      renderDigestEmail({
        summary: { ...base, taskCount: 0 },
        toEmail: "x@y.z",
        origin: "https://h",
      }).subject,
    ).toContain("quiet day");
    expect(
      renderDigestEmail({
        summary: { ...base, taskCount: 1 },
        toEmail: "x@y.z",
        origin: "https://h",
      }).subject,
    ).toContain("1 task");
    expect(
      renderDigestEmail({
        summary: { ...base, taskCount: 5 },
        toEmail: "x@y.z",
        origin: "https://h",
      }).subject,
    ).toContain("5 tasks");
  });
});

describe("runEmailDigest", () => {
  const NOW = Date.UTC(2026, 4, 7, 9, 0, 0);

  beforeEach(() => {
    seedUser({ id: "u1", email: "alice@example.com" });
    seedAgent("alpha", "s-alpha");
    seedPrefs({
      userId: "u1",
      emailDigestEnabled: true,
      hour: 9,
      tz: "UTC",
    });
  });

  it("skipped + audit when Resend not configured", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    const result = await runEmailDigest({ now: NOW, db });
    expect(result.considered).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    const audits = readAudit("notification.email-digest-skipped");
    expect(audits.length).toBe(1);
    expect(audits[0]!.user_id).toBe("u1");
    const payload = JSON.parse(audits[0]!.payload_json!);
    expect(payload.reason).toBe("resend_not_configured");
    // Privacy invariant — email plaintext NEVER in audit.
    expect(audits[0]!.payload_json!).not.toContain("alice@example.com");
    expect(typeof payload.targetEmailHash).toBe("string");
  });

  it("sends + audits with email hash", async () => {
    process.env.RESEND_API_KEY = "rk_test";
    process.env.RESEND_FROM_EMAIL = "Bridge <bridge@example.com>";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "msg_001" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const result = await runEmailDigest({ now: NOW, fetch: fakeFetch, db });
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const audits = readAudit("notification.email-digest-sent");
    expect(audits.length).toBe(1);
    expect(audits[0]!.payload_json!).not.toContain("alice@example.com");
    const payload = JSON.parse(audits[0]!.payload_json!);
    expect(typeof payload.targetEmailHash).toBe("string");
    expect(payload.taskCount).toBe(0);
  });

  it("records `failed` audit on Resend HTTP error", async () => {
    process.env.RESEND_API_KEY = "rk_test";
    process.env.RESEND_FROM_EMAIL = "bridge@example.com";
    const fakeFetch: typeof fetch = (async () =>
      new Response("oops", { status: 500 })) as unknown as typeof fetch;
    const result = await runEmailDigest({ now: NOW, fetch: fakeFetch, db });
    expect(result.failed).toBe(1);
    const audits = readAudit("notification.email-digest-failed");
    expect(audits.length).toBe(1);
    const payload = JSON.parse(audits[0]!.payload_json!);
    expect(payload.reason).toBe("resend_error");
    expect(payload.status).toBe(500);
  });

  it("records `failed` audit on Resend network error", async () => {
    process.env.RESEND_API_KEY = "rk_test";
    process.env.RESEND_FROM_EMAIL = "bridge@example.com";
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const result = await runEmailDigest({ now: NOW, fetch: fakeFetch, db });
    expect(result.failed).toBe(1);
    const audits = readAudit("notification.email-digest-failed");
    expect(JSON.parse(audits[0]!.payload_json!).reason).toBe("resend_network");
  });
});
