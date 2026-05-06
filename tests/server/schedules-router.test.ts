// P3-T5 — integration tests for `schedules.list`. Read-only over the
// vendored `schedules` table — no MCP, no audit. Same shape as the
// `loops.list` test fixture (tmp on-disk DB seeded against the live
// daemon column set).
//
// P3-T6 — `schedules.add` cases extend this file. Same fixture, plus
// audit-log wiring (the mutation writes to `audit_log` via
// `appendAudit`) and a fake MCP client per-test.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";

import { appRouter } from "../../src/server/routers/_app";
import { resetDb, getSqlite } from "../../src/server/db";
import { __resetAudit, __setAuditDb } from "../../src/server/audit";
import {
  McpPoolError,
  type CallOptions,
  type McpClient,
} from "../../src/server/mcp/pool";

// Daemon-owned `schedules` table. Mirrors the columns the daemon's
// scheduler maintains (see `claude-bridge` schema). We only pre-populate
// the columns the dashboard reads — the rest carry the daemon's
// CREATE TABLE defaults.
const SCHEMA_DDL = `
  CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    interval_minutes INTEGER,
    cron_expr TEXT,
    run_once INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    run_count INTEGER DEFAULT 0,
    consecutive_errors INTEGER DEFAULT 0,
    last_run_at TEXT,
    next_run_at TEXT,
    last_error TEXT,
    channel TEXT DEFAULT 'cli',
    channel_chat_id TEXT,
    user_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

interface SeedScheduleOpts {
  name: string;
  agentName?: string;
  prompt?: string;
  intervalMinutes?: number | null;
  cronExpr?: string | null;
  runOnce?: boolean;
  enabled?: boolean;
  runCount?: number;
  consecutiveErrors?: number;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastError?: string | null;
  channel?: string | null;
  createdAt?: string;
}

function seedSchedule(db: Database, opts: SeedScheduleOpts): number {
  const stmt = db.prepare(
    `INSERT INTO schedules
       (name, agent_name, prompt, interval_minutes, cron_expr,
        run_once, enabled, run_count, consecutive_errors,
        last_run_at, next_run_at, last_error, channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    opts.name,
    opts.agentName ?? "alpha",
    opts.prompt ?? "run the test suite",
    opts.intervalMinutes === undefined ? null : opts.intervalMinutes,
    opts.cronExpr === undefined ? null : opts.cronExpr,
    opts.runOnce ? 1 : 0,
    opts.enabled === undefined ? 1 : opts.enabled ? 1 : 0,
    opts.runCount ?? 0,
    opts.consecutiveErrors ?? 0,
    opts.lastRunAt ?? null,
    opts.nextRunAt ?? null,
    opts.lastError ?? null,
    opts.channel === undefined ? "cli" : opts.channel,
    opts.createdAt ?? "2026-05-06T00:00:00.000Z",
  );
  return Number(info.lastInsertRowid);
}

interface AuditRow {
  id: number;
  user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  payload_json: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  request_id: string | null;
  created_at: number;
}

function rows(d: Database): AuditRow[] {
  return d
    .prepare("SELECT * FROM audit_log ORDER BY id ASC")
    .all() as unknown as AuditRow[];
}

function makeReq(headers: Record<string, string> = {}, path = "schedules.add"): Request {
  return new Request(`http://localhost/api/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

interface RecordedCall {
  method: string;
  params: unknown;
  opts?: CallOptions;
}

function fakePool(
  handler: (call: RecordedCall) => Promise<unknown>,
): { client: McpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    client: {
      call(method, params, opts) {
        const c = { method, params, opts };
        calls.push(c);
        return handler(c);
      },
    },
    calls,
  };
}

let tmpDir: string;
let dbPath: string;
let db: Database;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.JWT_SECRET = "schedules-test-secret-please-do-not-use-in-prod";
  process.env.AUDIT_IP_HASH_SALT = "salty-schedules";
  tmpDir = mkdtempSync(join(tmpdir(), "schedules-router-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const setup = new Database(dbPath);
  setup.exec(SCHEMA_DDL);
  setup.close();
  process.env.BRIDGE_DB = dbPath;
  resetDb();
  db = getSqlite(); // also runs the audit_log migration
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
  ] as const) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key]!;
  }
});

describe("schedules.list — empty + ordering", () => {
  it("empty DB → empty page", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out).toEqual({ items: [] });
  });

  it("orders by nextRunAt ASC; null nextRunAt drops to bottom", async () => {
    seedSchedule(db, { name: "no-next", nextRunAt: null });
    seedSchedule(db, {
      name: "soon",
      nextRunAt: "2026-05-06T09:00:00.000Z",
    });
    seedSchedule(db, {
      name: "later",
      nextRunAt: "2026-05-07T09:00:00.000Z",
    });
    seedSchedule(db, {
      name: "earlier",
      nextRunAt: "2026-05-06T08:00:00.000Z",
    });
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out.items.map((r) => r.name)).toEqual([
      "earlier",
      "soon",
      "later",
      "no-next",
    ]);
  });
});

describe("schedules.list — wire shape", () => {
  it("projects every wire column with correct types", async () => {
    const id = seedSchedule(db, {
      name: "nightly-tests",
      agentName: "betty",
      prompt: "run the full test suite at midnight",
      cronExpr: "0 0 * * *",
      intervalMinutes: null,
      runOnce: false,
      enabled: true,
      runCount: 7,
      consecutiveErrors: 1,
      lastRunAt: "2026-05-05T00:00:00.000Z",
      nextRunAt: "2026-05-06T00:00:00.000Z",
      lastError: "exit code 1",
      channel: "telegram",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out.items.length).toBe(1);
    expect(out.items[0]!).toEqual({
      id,
      name: "nightly-tests",
      agentName: "betty",
      prompt: "run the full test suite at midnight",
      cronExpr: "0 0 * * *",
      intervalMinutes: null,
      enabled: true,
      runOnce: false,
      runCount: 7,
      consecutiveErrors: 1,
      lastRunAt: "2026-05-05T00:00:00.000Z",
      nextRunAt: "2026-05-06T00:00:00.000Z",
      lastError: "exit code 1",
      channel: "telegram",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("interval-mode (legacy) row carries intervalMinutes; cronExpr=null", async () => {
    seedSchedule(db, {
      name: "every-30",
      intervalMinutes: 30,
      cronExpr: null,
      nextRunAt: "2026-05-06T08:30:00.000Z",
    });
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out.items[0]!.intervalMinutes).toBe(30);
    expect(out.items[0]!.cronExpr).toBeNull();
  });

  it("disabled row reports enabled=false", async () => {
    seedSchedule(db, { name: "paused", enabled: false });
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out.items[0]!.enabled).toBe(false);
  });

  it("nullable columns surface as null", async () => {
    seedSchedule(db, {
      name: "fresh",
      cronExpr: null,
      intervalMinutes: null,
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
    });
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({});
    expect(out.items[0]!.cronExpr).toBeNull();
    expect(out.items[0]!.intervalMinutes).toBeNull();
    expect(out.items[0]!.lastRunAt).toBeNull();
    expect(out.items[0]!.nextRunAt).toBeNull();
    expect(out.items[0]!.lastError).toBeNull();
  });
});

describe("schedules.list — agent filter", () => {
  beforeEach(() => {
    seedSchedule(db, { name: "alpha-1", agentName: "alpha" });
    seedSchedule(db, { name: "alpha-2", agentName: "alpha" });
    seedSchedule(db, { name: "beta-1", agentName: "beta" });
  });

  it("agent filter narrows results", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({ agent: "alpha" });
    expect(out.items.map((r) => r.name).sort()).toEqual([
      "alpha-1",
      "alpha-2",
    ]);
  });

  it("unknown agent → empty page", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.schedules.list({ agent: "ghost" });
    expect(out.items).toEqual([]);
  });
});

describe("schedules.list — input validation", () => {
  it("rejects empty agent string", async () => {
    const caller = appRouter.createCaller({});
    let caught: TRPCError | null = null;
    try {
      await caller.schedules.list({ agent: "" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });
});

// ─────────────────────────────────────────────────────────────────────
// P3-T6 — schedules.add (mutation, calls bridge_schedule_add)
// ─────────────────────────────────────────────────────────────────────
//
// Mirrors the Phase 2 T01 `tasks.dispatch` and P3-T3 `loops.start` test
// surfaces: tmp on-disk DB so the audit row write goes through
// `getDb()` like prod, and a fake MCP client we shape per-test.
// Privacy precedent: the prompt text MUST NOT appear in
// `audit_log.payload_json` on either the success or failure path; we
// pin that explicitly.

describe("schedules.add — happy path (text envelope)", () => {
  it("returns { id } parsed from MCP `Schedule #N created` text", async () => {
    const { client, calls } = fakePool(async () => ({
      content: [{ type: "text", text: "Schedule #42 created" }],
    }));
    const req = makeReq(
      { "x-forwarded-for": "5.6.7.8", "user-agent": "ua/1" },
      "schedules.add",
    );

    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req });
    const out = await caller.schedules.add({
      agentName: "alpha",
      prompt: "SECRET_PROMPT_DO_NOT_LEAK",
      intervalMinutes: 60,
      name: "hourly-alpha",
      cronExpr: "0 * * * *",
    });
    expect(out).toEqual({ id: 42 });

    // MCP call params snake_case; prompt forwarded to daemon verbatim.
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("bridge_schedule_add");
    expect(calls[0]!.params).toEqual({
      agent_name: "alpha",
      prompt: "SECRET_PROMPT_DO_NOT_LEAK",
      interval_minutes: 60,
      name: "hourly-alpha",
      user_id: "owner",
    });
    expect(calls[0]!.opts?.timeoutMs).toBe(15_000);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("schedule.add");
    expect(all[0]!.resource_type).toBe("schedule");
    expect(all[0]!.resource_id).toBe("42");
    expect(all[0]!.user_id).toBe("owner");
    expect(all[0]!.ip_hash).not.toBeNull();
    expect(all[0]!.user_agent).toBe("ua/1");
    expect(all[0]!.request_id).toMatch(/^[0-9a-f-]{36}$/);

    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload).toEqual({
      agentName: "alpha",
      intervalMinutes: 60,
      hasPrompt: true,
      name: "hourly-alpha",
      cronExpr: "0 * * * *",
    });
    // Privacy invariant — the prompt text MUST NOT appear in audit.
    expect(all[0]!.payload_json).not.toContain("SECRET_PROMPT_DO_NOT_LEAK");
  });

  it("accepts the structured `{ id }` shape used by tests", async () => {
    const { client, calls } = fakePool(async () => ({ id: 7 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "schedules.add"),
    });
    const out = await caller.schedules.add({
      agentName: "alpha",
      prompt: "ship it",
      intervalMinutes: 1440,
    });
    expect(out).toEqual({ id: 7 });
    // Optional fields absent from input → absent from MCP params.
    expect(calls[0]!.params).toEqual({
      agent_name: "alpha",
      prompt: "ship it",
      interval_minutes: 1440,
      user_id: "owner",
    });
    const payload = JSON.parse(rows(db)[0]!.payload_json!);
    // hasPrompt sentinel always present on success; optional metadata absent.
    expect(payload).toEqual({
      agentName: "alpha",
      intervalMinutes: 1440,
      hasPrompt: true,
    });
  });

  it("forwards channelChatId and records hasChannelChatId sentinel only", async () => {
    const { client, calls } = fakePool(async () => ({ id: 9 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "schedules.add"),
    });
    await caller.schedules.add({
      agentName: "alpha",
      prompt: "noise",
      intervalMinutes: 60,
      channelChatId: "telegram-chat-99999",
    });
    expect((calls[0]!.params as { chat_id?: string }).chat_id).toBe(
      "telegram-chat-99999",
    );
    const payload = JSON.parse(rows(db)[0]!.payload_json!);
    expect(payload.hasChannelChatId).toBe(true);
    // The literal chat id should not be echoed (treat as semi-opaque).
    expect(payload.channelChatId).toBeUndefined();
  });

  it("omits user_id from MCP params when caller is unauthenticated", async () => {
    const { client, calls } = fakePool(async () => ({ id: 5 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: null,
      req: makeReq({}, "schedules.add"),
    });
    await caller.schedules.add({
      agentName: "alpha",
      prompt: "x",
      intervalMinutes: 60,
    });
    expect((calls[0]!.params as { user_id?: string }).user_id).toBeUndefined();
    expect(rows(db)[0]!.user_id).toBeNull();
  });
});

describe("schedules.add — input validation", () => {
  it("rejects empty prompt with BAD_REQUEST and writes no audit row", async () => {
    const { client, calls } = fakePool(async () => ({ id: 1 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "schedules.add"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.schedules.add({
        agentName: "alpha",
        prompt: "",
        intervalMinutes: 60,
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
    expect(rows(db).length).toBe(0);
  });

  it("rejects oversized prompt", async () => {
    const { client, calls } = fakePool(async () => ({ id: 1 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "schedules.add"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.schedules.add({
        agentName: "alpha",
        prompt: "x".repeat(32_001),
        intervalMinutes: 60,
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
  });

  it("rejects empty agentName", async () => {
    const { client } = fakePool(async () => ({ id: 1 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "schedules.add"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.schedules.add({
        agentName: "",
        prompt: "x",
        intervalMinutes: 60,
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });

  it("rejects intervalMinutes <= 0", async () => {
    const { client, calls } = fakePool(async () => ({ id: 1 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "schedules.add"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.schedules.add({
        agentName: "alpha",
        prompt: "x",
        intervalMinutes: 0,
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
  });

  it("rejects intervalMinutes > 30 days (43_200)", async () => {
    const { client } = fakePool(async () => ({ id: 1 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "schedules.add"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.schedules.add({
        agentName: "alpha",
        prompt: "x",
        intervalMinutes: 43_201,
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });

  it("rejects oversized cronExpr", async () => {
    const { client } = fakePool(async () => ({ id: 1 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "schedules.add"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.schedules.add({
        agentName: "alpha",
        prompt: "x",
        intervalMinutes: 60,
        cronExpr: "x".repeat(257),
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });
});

describe("schedules.add — malformed daemon response", () => {
  it("throws INTERNAL_SERVER_ERROR and audits malformed_response", async () => {
    const { client } = fakePool(async () => ({ ok: true })); // no id, no content
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "schedules.add"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.schedules.add({
        agentName: "alpha",
        prompt: "secret-prompt-text",
        intervalMinutes: 60,
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    expect(caught!.message).toMatch(/malformed/i);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("schedule.add.error");
    expect(all[0]!.resource_id).toBeNull();
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload.code).toBe("malformed_response");
    expect(payload.agentName).toBe("alpha");
    // Privacy on the error path too.
    expect(all[0]!.payload_json).not.toContain("secret-prompt-text");
  });

  it("throws on text envelope without a 'Schedule #N created' line", async () => {
    const { client } = fakePool(async () => ({
      content: [{ type: "text", text: "Schedule creation failed: agent busy" }],
    }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "schedules.add"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.schedules.add({
        agentName: "alpha",
        prompt: "x",
        intervalMinutes: 60,
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("schedules.add — MCP error mapping", () => {
  type Case = {
    name: string;
    poolCode: McpPoolError["code"];
    trpcCode: TRPCError["code"];
  };
  const cases: Case[] = [
    { name: "MCP_TIMEOUT → TIMEOUT", poolCode: "MCP_TIMEOUT", trpcCode: "TIMEOUT" },
    {
      name: "MCP_BACKPRESSURE → TOO_MANY_REQUESTS",
      poolCode: "MCP_BACKPRESSURE",
      trpcCode: "TOO_MANY_REQUESTS",
    },
    {
      name: "MCP_CONNECTION_LOST → INTERNAL_SERVER_ERROR",
      poolCode: "MCP_CONNECTION_LOST",
      trpcCode: "INTERNAL_SERVER_ERROR",
    },
    {
      name: "MCP_SPAWN_FAILED → INTERNAL_SERVER_ERROR",
      poolCode: "MCP_SPAWN_FAILED",
      trpcCode: "INTERNAL_SERVER_ERROR",
    },
    {
      name: "MCP_ABORTED → CLIENT_CLOSED_REQUEST",
      poolCode: "MCP_ABORTED",
      trpcCode: "CLIENT_CLOSED_REQUEST",
    },
    {
      name: "MCP_RPC_ERROR → INTERNAL_SERVER_ERROR",
      poolCode: "MCP_RPC_ERROR",
      trpcCode: "INTERNAL_SERVER_ERROR",
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const { client } = fakePool(async () => {
        throw new McpPoolError(c.poolCode, "boom");
      });
      const caller = appRouter.createCaller({
        mcp: client,
        userId: "owner",
        req: makeReq({}, "schedules.add"),
      });
      let caught: TRPCError | null = null;
      try {
        await caller.schedules.add({
          agentName: "alpha",
          prompt: "private prompt text",
          intervalMinutes: 60,
        });
      } catch (e) {
        caught = e as TRPCError;
      }
      expect(caught).toBeInstanceOf(TRPCError);
      expect(caught!.code).toBe(c.trpcCode);

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("schedule.add.error");
      expect(all[0]!.resource_id).toBeNull();
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload.code).toBe(c.poolCode);
      expect(payload.agentName).toBe("alpha");
      // Privacy on every error branch.
      expect(all[0]!.payload_json).not.toContain("private prompt text");
    });
  }
});

describe("schedules.add — MCP context missing", () => {
  it("returns INTERNAL_SERVER_ERROR when no MCP client wired", async () => {
    const caller = appRouter.createCaller({
      userId: "owner",
      req: makeReq({}, "schedules.add"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.schedules.add({
        agentName: "alpha",
        prompt: "x",
        intervalMinutes: 60,
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    // No audit row — context guard fires before the audit envelope.
    expect(rows(db).length).toBe(0);
  });
});
