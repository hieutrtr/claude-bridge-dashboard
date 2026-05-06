// T06 — integration tests for the `loops.approve` and `loops.reject`
// tRPC mutations. Same shape as `kill-router.test.ts`: tmp on-disk DB
// (so the procedure can resolve the `loops` row to derive
// `pendingApproval` + `status`) + injected fake MCP client.
//
// The headline behaviour is the multi-channel race: a loop sitting in
// `pending_approval=true` may be approved on the dashboard while
// simultaneously rejected on Telegram. The procedure must turn that
// race into a friendly `{ ok: true, alreadyFinalized: true }` rather
// than a confusing 500 — both the server-side check (`pendingApproval=
// false`) and the daemon-side regex (`already approved/rejected/...`)
// land on the same shape.

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

// Daemon-owned `loops` table — same shape as the live daemon DB but
// trimmed to the columns the procedure actually reads (status,
// pending_approval) plus the NOT NULL columns the daemon would have
// populated. `audit_log` is created by `runMigrations` once
// `BRIDGE_DB` points at the file.
const SCHEMA_DDL = `
  CREATE TABLE loops (
    loop_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    project TEXT NOT NULL,
    goal TEXT NOT NULL,
    done_when TEXT NOT NULL,
    loop_type TEXT NOT NULL DEFAULT 'bridge',
    status TEXT NOT NULL DEFAULT 'running',
    max_iterations INTEGER NOT NULL DEFAULT 10,
    max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
    current_iteration INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    max_cost_usd REAL,
    pending_approval INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    finish_reason TEXT,
    current_task_id TEXT,
    channel TEXT,
    channel_chat_id TEXT,
    user_id TEXT,
    plan TEXT,
    plan_enabled INTEGER NOT NULL DEFAULT 0,
    pass_threshold INTEGER NOT NULL DEFAULT 1,
    consecutive_passes INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE loop_iterations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loop_id TEXT NOT NULL,
    iteration_num INTEGER NOT NULL,
    task_id TEXT,
    prompt TEXT,
    result_summary TEXT,
    done_check_passed INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running'
  );
`;

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

function rows(db: Database): AuditRow[] {
  return db
    .prepare("SELECT * FROM audit_log ORDER BY id ASC")
    .all() as unknown as AuditRow[];
}

function makeReq(headers: Record<string, string> = {}, path = "loops.approve"): Request {
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

interface SeedLoopOpts {
  loopId: string;
  agent?: string;
  status?: string;
  pendingApproval?: boolean;
}

function seedLoop(db: Database, opts: SeedLoopOpts): void {
  const agent = opts.agent ?? "alpha";
  const status = opts.status ?? "running";
  const pa = opts.pendingApproval === undefined ? 1 : opts.pendingApproval ? 1 : 0;
  db.prepare(
    `INSERT INTO loops
       (loop_id, agent, project, goal, done_when, status, pending_approval,
        total_cost_usd, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    opts.loopId,
    agent,
    `/tmp/${agent}`,
    "fix all tests",
    "manual:",
    status,
    pa,
    new Date().toISOString(),
  );
}

const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  process.env.JWT_SECRET = "loops-test-secret-please-do-not-use-in-prod";
  process.env.AUDIT_IP_HASH_SALT = "salty-loops";
  tmpDir = mkdtempSync(join(tmpdir(), "loops-router-test-"));
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

// ─────────────────────────────────────────────────────────────────────
// loops.approve
// ─────────────────────────────────────────────────────────────────────

describe("loops.approve — happy path", () => {
  it("pending → calls bridge_loop_approve and returns alreadyFinalized:false", async () => {
    seedLoop(db, { loopId: "loop-1", pendingApproval: true });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const req = makeReq({ "x-forwarded-for": "5.6.7.8", "user-agent": "ua/1" });

    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req });
    const out = await caller.loops.approve({ loopId: "loop-1" });
    expect(out).toEqual({ ok: true, alreadyFinalized: false });

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("bridge_loop_approve");
    expect(calls[0]!.params).toEqual({ loop_id: "loop-1" });
    expect(calls[0]!.opts?.timeoutMs).toBe(15_000);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("loop.approve");
    expect(all[0]!.resource_type).toBe("loop");
    expect(all[0]!.resource_id).toBe("loop-1");
    expect(all[0]!.user_id).toBe("owner");
    expect(all[0]!.ip_hash).not.toBeNull();
    expect(all[0]!.user_agent).toBe("ua/1");
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload).toEqual({
      status: "running",
      alreadyFinalized: false,
    });
  });
});

describe("loops.approve — already finalized (server-side check, no MCP call)", () => {
  it("pending_approval=false → returns alreadyFinalized:true without calling MCP", async () => {
    seedLoop(db, { loopId: "loop-10", pendingApproval: false, status: "running" });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
    const out = await caller.loops.approve({ loopId: "loop-10" });
    expect(out).toEqual({ ok: true, alreadyFinalized: true });
    expect(calls.length).toBe(0);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("loop.approve");
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload).toEqual({
      status: "running",
      alreadyFinalized: true,
    });
  });

  for (const status of ["done", "cancelled", "failed"] as const) {
    it(`status=${status} (pa=false) → alreadyFinalized:true without MCP`, async () => {
      seedLoop(db, { loopId: `loop-${status}`, pendingApproval: false, status });
      const { client, calls } = fakePool(async () => ({ ok: true }));
      const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
      const out = await caller.loops.approve({ loopId: `loop-${status}` });
      expect(out).toEqual({ ok: true, alreadyFinalized: true });
      expect(calls.length).toBe(0);
      const payload = JSON.parse(rows(db)[0]!.payload_json!);
      expect(payload.status).toBe(status);
      expect(payload.alreadyFinalized).toBe(true);
    });
  }
});

describe("loops.approve — daemon race (MCP_RPC_ERROR with race-pattern message)", () => {
  const racePatterns = [
    "loop already approved",
    "loop already rejected",
    "already finalized",
    "loop not pending approval",
    "not pending approval",
    "already finished",
    "already cancelled",
    "already canceled",
    "already done",
  ];

  for (const message of racePatterns) {
    it(`swallows "${message}" → alreadyFinalized:true`, async () => {
      seedLoop(db, { loopId: "loop-race", pendingApproval: true });
      const { client } = fakePool(async () => {
        throw new McpPoolError("MCP_RPC_ERROR", message);
      });
      const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
      const out = await caller.loops.approve({ loopId: "loop-race" });
      expect(out).toEqual({ ok: true, alreadyFinalized: true });

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("loop.approve");
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload.alreadyFinalized).toBe(true);
      expect(payload.raceDetected).toBe(true);
    });
  }

  it("does NOT swallow generic MCP_RPC_ERROR (e.g. agent panic)", async () => {
    seedLoop(db, { loopId: "loop-panic", pendingApproval: true });
    const { client } = fakePool(async () => {
      throw new McpPoolError("MCP_RPC_ERROR", "daemon panic: out of memory");
    });
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.approve({ loopId: "loop-panic" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("loop.approve.error");
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload.code).toBe("MCP_RPC_ERROR");
    expect(payload.status).toBe("running");
  });
});

describe("loops.approve — loop not found", () => {
  it("unknown loopId → NOT_FOUND, no audit row, no MCP call", async () => {
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.approve({ loopId: "ghost" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("NOT_FOUND");
    expect(caught!.message).toMatch(/loop not found/i);
    expect(calls.length).toBe(0);
    expect(rows(db).length).toBe(0);
  });
});

describe("loops.approve — input validation", () => {
  it("rejects empty loopId with BAD_REQUEST", async () => {
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.approve({ loopId: "" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
    expect(rows(db).length).toBe(0);
  });

  it("rejects oversize loopId (>128 chars)", async () => {
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.approve({ loopId: "x".repeat(129) });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
  });
});

describe("loops.approve — MCP error mapping", () => {
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
  ];

  for (const c of cases) {
    it(c.name, async () => {
      seedLoop(db, { loopId: "loop-err", pendingApproval: true });
      const { client } = fakePool(async () => {
        throw new McpPoolError(c.poolCode, "boom");
      });
      const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
      let caught: TRPCError | null = null;
      try {
        await caller.loops.approve({ loopId: "loop-err" });
      } catch (e) {
        caught = e as TRPCError;
      }
      expect(caught).toBeInstanceOf(TRPCError);
      expect(caught!.code).toBe(c.trpcCode);

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("loop.approve.error");
      expect(all[0]!.resource_id).toBe("loop-err");
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload.code).toBe(c.poolCode);
      expect(payload.status).toBe("running");
    });
  }
});

describe("loops.approve — context propagation", () => {
  it("writes user_id=null when caller is unauthenticated", async () => {
    seedLoop(db, { loopId: "loop-anon", pendingApproval: true });
    const { client } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({ mcp: client, userId: null, req: makeReq() });
    await caller.loops.approve({ loopId: "loop-anon" });
    expect(rows(db)[0]!.user_id).toBeNull();
  });
});

describe("loops.approve — repeated call idempotency", () => {
  it("first approve succeeds; second approve (after pa flips) is alreadyFinalized", async () => {
    seedLoop(db, { loopId: "loop-rep", pendingApproval: true });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });

    const first = await caller.loops.approve({ loopId: "loop-rep" });
    expect(first).toEqual({ ok: true, alreadyFinalized: false });
    expect(calls.length).toBe(1);

    db.prepare("UPDATE loops SET pending_approval = 0 WHERE loop_id = ?").run("loop-rep");

    const second = await caller.loops.approve({ loopId: "loop-rep" });
    expect(second).toEqual({ ok: true, alreadyFinalized: true });
    expect(calls.length).toBe(1);

    const all = rows(db);
    expect(all.length).toBe(2);
    expect(all[0]!.action).toBe("loop.approve");
    expect(all[1]!.action).toBe("loop.approve");
    expect(JSON.parse(all[0]!.payload_json!).alreadyFinalized).toBe(false);
    expect(JSON.parse(all[1]!.payload_json!).alreadyFinalized).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// loops.reject
// ─────────────────────────────────────────────────────────────────────

describe("loops.reject — happy path with reason", () => {
  it("calls bridge_loop_reject with feedback; reason is NOT echoed into audit", async () => {
    seedLoop(db, { loopId: "loop-rej-1", pendingApproval: true });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const req = makeReq({ "x-forwarded-for": "5.6.7.8" }, "loops.reject");
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req });
    const out = await caller.loops.reject({ loopId: "loop-rej-1", reason: "bad output" });
    expect(out).toEqual({ ok: true, alreadyFinalized: false });

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("bridge_loop_reject");
    expect(calls[0]!.params).toEqual({ loop_id: "loop-rej-1", feedback: "bad output" });
    expect(calls[0]!.opts?.timeoutMs).toBe(15_000);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("loop.reject");
    expect(all[0]!.resource_type).toBe("loop");
    expect(all[0]!.resource_id).toBe("loop-rej-1");
    expect(all[0]!.user_id).toBe("owner");
    expect(all[0]!.ip_hash).not.toBeNull();
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload).toEqual({
      status: "running",
      alreadyFinalized: false,
      hasReason: true,
    });
    // Privacy: the reason text MUST NOT appear in payload_json.
    expect(all[0]!.payload_json).not.toContain("bad output");
  });
});

describe("loops.reject — happy path without reason", () => {
  it("omits feedback key from MCP params and audit hasReason flag", async () => {
    seedLoop(db, { loopId: "loop-rej-2", pendingApproval: true });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.reject"),
    });
    const out = await caller.loops.reject({ loopId: "loop-rej-2" });
    expect(out).toEqual({ ok: true, alreadyFinalized: false });

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("bridge_loop_reject");
    expect(calls[0]!.params).toEqual({ loop_id: "loop-rej-2" });

    const payload = JSON.parse(rows(db)[0]!.payload_json!);
    expect(payload.hasReason).toBeFalsy();
    expect(payload.alreadyFinalized).toBe(false);
  });
});

describe("loops.reject — already finalized (server-side check, no MCP call)", () => {
  it("pending_approval=false → returns alreadyFinalized:true without calling MCP", async () => {
    seedLoop(db, { loopId: "loop-rej-fin", pendingApproval: false, status: "done" });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.reject"),
    });
    const out = await caller.loops.reject({ loopId: "loop-rej-fin", reason: "too late" });
    expect(out).toEqual({ ok: true, alreadyFinalized: true });
    expect(calls.length).toBe(0);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("loop.reject");
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload.alreadyFinalized).toBe(true);
    expect(payload.status).toBe("done");
    expect(all[0]!.payload_json).not.toContain("too late");
  });
});

describe("loops.reject — daemon race", () => {
  const racePatterns = [
    "loop already approved",
    "loop already rejected",
    "already finalized",
    "not pending approval",
  ];
  for (const message of racePatterns) {
    it(`swallows "${message}" → alreadyFinalized:true`, async () => {
      seedLoop(db, { loopId: "loop-rej-race", pendingApproval: true });
      const { client } = fakePool(async () => {
        throw new McpPoolError("MCP_RPC_ERROR", message);
      });
      const caller = appRouter.createCaller({
        mcp: client,
        userId: "owner",
        req: makeReq({}, "loops.reject"),
      });
      const out = await caller.loops.reject({ loopId: "loop-rej-race" });
      expect(out).toEqual({ ok: true, alreadyFinalized: true });

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("loop.reject");
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload.raceDetected).toBe(true);
      expect(payload.alreadyFinalized).toBe(true);
    });
  }
});

describe("loops.reject — loop not found", () => {
  it("unknown loopId → NOT_FOUND, no audit row, no MCP call", async () => {
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.reject"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.reject({ loopId: "ghost", reason: "nope" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("NOT_FOUND");
    expect(calls.length).toBe(0);
    expect(rows(db).length).toBe(0);
  });
});

describe("loops.reject — input validation", () => {
  it("rejects oversize reason (>1000 chars) with BAD_REQUEST", async () => {
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.reject"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.reject({ loopId: "loop-1", reason: "x".repeat(1001) });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
  });

  it("rejects empty loopId with BAD_REQUEST", async () => {
    const { client } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.reject"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.reject({ loopId: "" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });
});

describe("loops.reject — MCP error mapping", () => {
  it("MCP_TIMEOUT → TIMEOUT and audits loop.reject.error", async () => {
    seedLoop(db, { loopId: "loop-rej-err", pendingApproval: true });
    const { client } = fakePool(async () => {
      throw new McpPoolError("MCP_TIMEOUT", "timeout");
    });
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.reject"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.reject({ loopId: "loop-rej-err", reason: "rationale" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("TIMEOUT");

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("loop.reject.error");
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload.code).toBe("MCP_TIMEOUT");
    // Privacy preserved on the error path too.
    expect(all[0]!.payload_json).not.toContain("rationale");
  });
});

describe("loops — multi-channel race (approve then reject)", () => {
  it("approve flips pa=false; subsequent reject hits early-return", async () => {
    seedLoop(db, { loopId: "loop-multi", pendingApproval: true });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.approve"),
    });

    const first = await caller.loops.approve({ loopId: "loop-multi" });
    expect(first).toEqual({ ok: true, alreadyFinalized: false });
    expect(calls.length).toBe(1);

    // Daemon would flip the flag after a successful approve.
    db.prepare("UPDATE loops SET pending_approval = 0 WHERE loop_id = ?").run("loop-multi");

    const second = await caller.loops.reject({
      loopId: "loop-multi",
      reason: "too late",
    });
    expect(second).toEqual({ ok: true, alreadyFinalized: true });
    expect(calls.length).toBe(1);

    const all = rows(db);
    expect(all.length).toBe(2);
    expect(all[0]!.action).toBe("loop.approve");
    expect(all[1]!.action).toBe("loop.reject");
    expect(JSON.parse(all[1]!.payload_json!).alreadyFinalized).toBe(true);
    expect(all[1]!.payload_json).not.toContain("too late");
  });
});

// ─────────────────────────────────────────────────────────────────────
// P3-T1 — loops.list (read-only query, no MCP)
// ─────────────────────────────────────────────────────────────────────
//
// `seedLoop` only fills the columns the approve / reject procedures
// read. `loops.list` projects more columns, so this helper takes the
// extras explicitly. Defaults match the daemon's CREATE TABLE
// defaults.

interface SeedListLoopOpts {
  loopId: string;
  agent?: string;
  status?: string;
  loopType?: string;
  pendingApproval?: boolean;
  currentIteration?: number;
  maxIterations?: number;
  totalCostUsd?: number;
  maxCostUsd?: number | null;
  startedAt?: string;
  finishedAt?: string | null;
  finishReason?: string | null;
  goal?: string;
}

function seedListLoop(db: Database, opts: SeedListLoopOpts): void {
  const agent = opts.agent ?? "alpha";
  const status = opts.status ?? "running";
  const loopType = opts.loopType ?? "bridge";
  const pa = opts.pendingApproval === undefined ? 0 : opts.pendingApproval ? 1 : 0;
  const currentIteration = opts.currentIteration ?? 0;
  const maxIterations = opts.maxIterations ?? 10;
  const totalCostUsd = opts.totalCostUsd ?? 0;
  const maxCostUsd = opts.maxCostUsd === undefined ? null : opts.maxCostUsd;
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const finishedAt = opts.finishedAt ?? null;
  const finishReason = opts.finishReason ?? null;
  const goal = opts.goal ?? "fix all tests";
  db.prepare(
    `INSERT INTO loops
       (loop_id, agent, project, goal, done_when, loop_type, status,
        max_iterations, current_iteration, total_cost_usd, max_cost_usd,
        pending_approval, started_at, finished_at, finish_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.loopId,
    agent,
    `/tmp/${agent}`,
    goal,
    "manual:",
    loopType,
    status,
    maxIterations,
    currentIteration,
    totalCostUsd,
    maxCostUsd,
    pa,
    startedAt,
    finishedAt,
    finishReason,
  );
}

describe("loops.list — empty + ordering", () => {
  it("empty DB → empty page, null cursor", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.loops.list({});
    expect(out).toEqual({ items: [], nextCursor: null });
  });

  it("orders DESC by started_at", async () => {
    // Inserted out of order on purpose.
    seedListLoop(db, {
      loopId: "loop-mid",
      startedAt: "2026-05-04T12:00:00.000Z",
    });
    seedListLoop(db, {
      loopId: "loop-old",
      startedAt: "2026-05-01T10:00:00.000Z",
    });
    seedListLoop(db, {
      loopId: "loop-new",
      startedAt: "2026-05-06T08:00:00.000Z",
    });
    const caller = appRouter.createCaller({});
    const out = await caller.loops.list({});
    expect(out.items.map((r) => r.loopId)).toEqual([
      "loop-new",
      "loop-mid",
      "loop-old",
    ]);
  });
});

describe("loops.list — wire shape", () => {
  it("projects only the wire columns; no `goal` text leaks", async () => {
    seedListLoop(db, {
      loopId: "loop-shape",
      agent: "betty",
      status: "running",
      loopType: "agent",
      currentIteration: 3,
      maxIterations: 8,
      totalCostUsd: 0.123,
      maxCostUsd: 5.0,
      pendingApproval: true,
      startedAt: "2026-05-06T01:02:03.000Z",
      finishedAt: null,
      finishReason: null,
      goal: "SECRET_GOAL_TEXT_DO_NOT_LEAK",
    });
    const caller = appRouter.createCaller({});
    const out = await caller.loops.list({});
    expect(out.items.length).toBe(1);
    const row = out.items[0]!;
    expect(row).toEqual({
      loopId: "loop-shape",
      agent: "betty",
      status: "running",
      loopType: "agent",
      currentIteration: 3,
      maxIterations: 8,
      totalCostUsd: 0.123,
      maxCostUsd: 5.0,
      pendingApproval: true,
      startedAt: "2026-05-06T01:02:03.000Z",
      finishedAt: null,
      finishReason: null,
    });
    // Privacy: `goal` is not part of the list payload.
    expect(JSON.stringify(row)).not.toContain("SECRET_GOAL_TEXT_DO_NOT_LEAK");
  });

  it("nullable columns surface as null", async () => {
    seedListLoop(db, {
      loopId: "loop-null",
      maxCostUsd: null,
      finishedAt: null,
      finishReason: null,
    });
    const caller = appRouter.createCaller({});
    const out = await caller.loops.list({});
    expect(out.items[0]!.maxCostUsd).toBeNull();
    expect(out.items[0]!.finishedAt).toBeNull();
    expect(out.items[0]!.finishReason).toBeNull();
  });
});

describe("loops.list — filters", () => {
  beforeEach(() => {
    seedListLoop(db, {
      loopId: "loop-a-running",
      agent: "alpha",
      status: "running",
      pendingApproval: false,
      startedAt: "2026-05-01T10:00:00.000Z",
    });
    seedListLoop(db, {
      loopId: "loop-a-done",
      agent: "alpha",
      status: "done",
      pendingApproval: false,
      startedAt: "2026-05-02T10:00:00.000Z",
    });
    seedListLoop(db, {
      loopId: "loop-b-running-pa",
      agent: "beta",
      status: "running",
      pendingApproval: true,
      startedAt: "2026-05-03T10:00:00.000Z",
    });
    seedListLoop(db, {
      loopId: "loop-b-cancelled",
      agent: "beta",
      status: "cancelled",
      pendingApproval: false,
      startedAt: "2026-05-04T10:00:00.000Z",
    });
  });

  it("agent filter narrows to one agent", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.loops.list({ agent: "alpha" });
    expect(out.items.map((r) => r.loopId).sort()).toEqual([
      "loop-a-done",
      "loop-a-running",
    ]);
  });

  it("status='running' returns running loops (regardless of pa flag)", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.loops.list({ status: "running" });
    expect(out.items.map((r) => r.loopId).sort()).toEqual([
      "loop-a-running",
      "loop-b-running-pa",
    ]);
  });

  it("status='waiting_approval' surfaces only loops with pending_approval=true", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.loops.list({ status: "waiting_approval" });
    expect(out.items.map((r) => r.loopId)).toEqual(["loop-b-running-pa"]);
  });

  it("agent + status combine (AND)", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.loops.list({
      agent: "beta",
      status: "running",
    });
    expect(out.items.map((r) => r.loopId)).toEqual(["loop-b-running-pa"]);
  });

  it("unknown agent → empty page", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.loops.list({ agent: "ghost" });
    expect(out).toEqual({ items: [], nextCursor: null });
  });
});

describe("loops.list — pagination via started_at cursor", () => {
  it("returns nextCursor when page is full; second page is older rows", async () => {
    const ts = (i: number): string =>
      new Date(Date.UTC(2026, 4, 6, 0, 0, i)).toISOString();
    for (let i = 0; i < 5; i++) {
      seedListLoop(db, {
        loopId: `loop-${i}`,
        startedAt: ts(i),
      });
    }
    const caller = appRouter.createCaller({});
    const page1 = await caller.loops.list({ limit: 2 });
    expect(page1.items.map((r) => r.loopId)).toEqual(["loop-4", "loop-3"]);
    expect(page1.nextCursor).toBe(ts(3));

    const page2 = await caller.loops.list({
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((r) => r.loopId)).toEqual(["loop-2", "loop-1"]);
    expect(page2.nextCursor).toBe(ts(1));

    const page3 = await caller.loops.list({
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.items.map((r) => r.loopId)).toEqual(["loop-0"]);
    expect(page3.nextCursor).toBeNull();
  });

  it("limit defaults sensibly and clamps to max", async () => {
    const caller = appRouter.createCaller({});
    let caught: TRPCError | null = null;
    try {
      await caller.loops.list({ limit: 1000 });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });
});

describe("loops.list — input validation", () => {
  it("rejects empty status string", async () => {
    const caller = appRouter.createCaller({});
    let caught: TRPCError | null = null;
    try {
      await caller.loops.list({ status: "" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });

  it("rejects empty agent string", async () => {
    const caller = appRouter.createCaller({});
    let caught: TRPCError | null = null;
    try {
      await caller.loops.list({ agent: "" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });
});

// ─────────────────────────────────────────────────────────────────────
// P3-T2 — loops.get (read-only query, no MCP)
// ─────────────────────────────────────────────────────────────────────

interface SeedIterOpts {
  loopId: string;
  iterationNum: number;
  taskId?: string | null;
  prompt?: string | null;
  resultSummary?: string | null;
  doneCheckPassed?: boolean;
  costUsd?: number;
  startedAt?: string;
  finishedAt?: string | null;
  status?: string;
}

function seedIter(db: Database, opts: SeedIterOpts): void {
  db.prepare(
    `INSERT INTO loop_iterations
       (loop_id, iteration_num, task_id, prompt, result_summary,
        done_check_passed, cost_usd, started_at, finished_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.loopId,
    opts.iterationNum,
    opts.taskId ?? null,
    opts.prompt ?? null,
    opts.resultSummary ?? null,
    opts.doneCheckPassed ? 1 : 0,
    opts.costUsd ?? 0,
    opts.startedAt ??
      new Date(2026, 4, 6, 0, 0, opts.iterationNum).toISOString(),
    opts.finishedAt ?? null,
    opts.status ?? "running",
  );
}

describe("loops.get — unknown id", () => {
  it("returns null for an unknown loop_id", async () => {
    const caller = appRouter.createCaller({});
    const out = await caller.loops.get({ loopId: "ghost" });
    expect(out).toBeNull();
  });
});

describe("loops.get — happy path", () => {
  it("projects all detail fields plus iterations ASC by iteration_num", async () => {
    seedListLoop(db, {
      loopId: "loop-detail",
      agent: "alpha",
      status: "running",
      currentIteration: 3,
      maxIterations: 10,
      totalCostUsd: 0.0345,
      maxCostUsd: 5.0,
      pendingApproval: false,
      startedAt: "2026-05-06T00:00:00.000Z",
      goal: "ship the feature",
    });
    // Insert iterations out of order.
    seedIter(db, {
      loopId: "loop-detail",
      iterationNum: 2,
      taskId: "task-2",
      prompt: "iter 2 prompt",
      resultSummary: "iter 2 result",
      costUsd: 0.012,
      doneCheckPassed: false,
      status: "done",
      startedAt: "2026-05-06T00:00:02.000Z",
      finishedAt: "2026-05-06T00:00:05.000Z",
    });
    seedIter(db, {
      loopId: "loop-detail",
      iterationNum: 1,
      taskId: "task-1",
      prompt: "iter 1 prompt",
      resultSummary: "iter 1 result",
      costUsd: 0.0095,
      doneCheckPassed: false,
      status: "done",
      startedAt: "2026-05-06T00:00:01.000Z",
      finishedAt: "2026-05-06T00:00:02.000Z",
    });
    seedIter(db, {
      loopId: "loop-detail",
      iterationNum: 3,
      taskId: "task-3",
      prompt: "iter 3 prompt",
      resultSummary: null,
      costUsd: 0.013,
      doneCheckPassed: true,
      status: "running",
      startedAt: "2026-05-06T00:00:05.000Z",
      finishedAt: null,
    });

    const caller = appRouter.createCaller({});
    const out = await caller.loops.get({ loopId: "loop-detail" });
    expect(out).not.toBeNull();
    expect(out!.loopId).toBe("loop-detail");
    expect(out!.agent).toBe("alpha");
    expect(out!.goal).toBe("ship the feature");
    expect(out!.maxIterations).toBe(10);
    expect(out!.totalCostUsd).toBeCloseTo(0.0345, 6);
    expect(out!.maxCostUsd).toBe(5.0);
    expect(out!.pendingApproval).toBe(false);

    // Iterations are ordered ascending.
    expect(out!.iterations.map((i) => i.iterationNum)).toEqual([1, 2, 3]);
    expect(out!.iterations[2]!.doneCheckPassed).toBe(true);
    expect(out!.iterations[2]!.taskId).toBe("task-3");
    expect(out!.iterations[1]!.resultSummary).toBe("iter 2 result");
    expect(out!.iterationsTruncated).toBe(false);
    expect(out!.totalIterations).toBe(3);
  });

  it("returns empty iterations array when none recorded yet", async () => {
    seedListLoop(db, { loopId: "loop-fresh", agent: "alpha" });
    const caller = appRouter.createCaller({});
    const out = await caller.loops.get({ loopId: "loop-fresh" });
    expect(out).not.toBeNull();
    expect(out!.iterations).toEqual([]);
    expect(out!.iterationsTruncated).toBe(false);
    expect(out!.totalIterations).toBe(0);
  });

  it("returns nullable columns as null (maxCostUsd, finishedAt, currentTaskId)", async () => {
    seedListLoop(db, {
      loopId: "loop-nullable",
      maxCostUsd: null,
      finishedAt: null,
      finishReason: null,
    });
    const caller = appRouter.createCaller({});
    const out = await caller.loops.get({ loopId: "loop-nullable" });
    expect(out!.maxCostUsd).toBeNull();
    expect(out!.finishedAt).toBeNull();
    expect(out!.finishReason).toBeNull();
    expect(out!.currentTaskId).toBeNull();
  });
});

describe("loops.get — iteration cap", () => {
  it("clips to the most recent 100 when totalIterations > 100", async () => {
    seedListLoop(db, {
      loopId: "loop-big",
      maxIterations: 200,
      currentIteration: 150,
    });
    for (let i = 1; i <= 150; i++) {
      seedIter(db, {
        loopId: "loop-big",
        iterationNum: i,
        costUsd: 0.001,
        startedAt: new Date(2026, 4, 6, 0, 0, i).toISOString(),
        status: "done",
      });
    }
    const caller = appRouter.createCaller({});
    const out = await caller.loops.get({ loopId: "loop-big" });
    expect(out!.iterations.length).toBe(100);
    // The 100 most-recent rows, ASC: iter 51..150.
    expect(out!.iterations[0]!.iterationNum).toBe(51);
    expect(out!.iterations[99]!.iterationNum).toBe(150);
    expect(out!.iterationsTruncated).toBe(true);
    expect(out!.totalIterations).toBe(150);
  });
});

describe("loops.get — input validation", () => {
  it("rejects empty loopId", async () => {
    const caller = appRouter.createCaller({});
    let caught: TRPCError | null = null;
    try {
      await caller.loops.get({ loopId: "" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });

  it("rejects loopId longer than 128 chars", async () => {
    const caller = appRouter.createCaller({});
    let caught: TRPCError | null = null;
    try {
      await caller.loops.get({ loopId: "x".repeat(129) });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });
});

// ─────────────────────────────────────────────────────────────────────
// P3-T3 — loops.start (mutation, calls bridge_loop)
// ─────────────────────────────────────────────────────────────────────
//
// Mirrors the Phase 2 T01 `tasks.dispatch` test surface: tmp on-disk
// DB so the audit row write goes through `getDb()` like prod, and a
// fake MCP client we shape per-test. Privacy precedent: the goal text
// MUST NOT appear in `audit_log.payload_json` on either the success
// or failure path; we pin that explicitly.

describe("loops.start — happy path (text envelope)", () => {
  it("returns { loopId } parsed from MCP `Started loop <id>` text", async () => {
    const { client, calls } = fakePool(async () => ({
      content: [{ type: "text", text: "Started loop loop-abc123" }],
    }));
    const req = makeReq(
      { "x-forwarded-for": "5.6.7.8", "user-agent": "ua/1" },
      "loops.start",
    );

    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req });
    const out = await caller.loops.start({
      agentName: "alpha",
      goal: "SECRET_LOOP_GOAL_DO_NOT_LEAK",
      doneWhen: "manual:",
      maxIterations: 8,
      maxCostUsd: 5.0,
      loopType: "bridge",
      planFirst: true,
      passThreshold: 2,
    });
    expect(out).toEqual({ loopId: "loop-abc123" });

    // MCP call params snake_case; goal forwarded to daemon verbatim.
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("bridge_loop");
    expect(calls[0]!.params).toEqual({
      agent: "alpha",
      goal: "SECRET_LOOP_GOAL_DO_NOT_LEAK",
      done_when: "manual:",
      max_iterations: 8,
      max_cost_usd: 5.0,
      loop_type: "bridge",
      plan_first: true,
      pass_threshold: 2,
      user_id: "owner",
    });
    expect(calls[0]!.opts?.timeoutMs).toBe(15_000);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("loop.start");
    expect(all[0]!.resource_type).toBe("loop");
    expect(all[0]!.resource_id).toBe("loop-abc123");
    expect(all[0]!.user_id).toBe("owner");
    expect(all[0]!.ip_hash).not.toBeNull();
    expect(all[0]!.user_agent).toBe("ua/1");
    expect(all[0]!.request_id).toMatch(/^[0-9a-f-]{36}$/);

    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload).toEqual({
      agentName: "alpha",
      doneWhen: "manual:",
      hasGoal: true,
      maxIterations: 8,
      maxCostUsd: 5.0,
      loopType: "bridge",
      planFirst: true,
      passThreshold: 2,
    });
    // Privacy invariant — the goal text MUST NOT appear in audit.
    expect(all[0]!.payload_json).not.toContain("SECRET_LOOP_GOAL_DO_NOT_LEAK");
  });

  it("accepts the structured `{ loop_id }` shape used by tests", async () => {
    const { client, calls } = fakePool(async () => ({ loop_id: "loop-xyz" }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.start"),
    });
    const out = await caller.loops.start({
      agentName: "alpha",
      goal: "ship it",
      doneWhen: "llm_judge: tests pass",
    });
    expect(out).toEqual({ loopId: "loop-xyz" });
    // Optional fields absent from input → absent from MCP params.
    expect(calls[0]!.params).toEqual({
      agent: "alpha",
      goal: "ship it",
      done_when: "llm_judge: tests pass",
      user_id: "owner",
    });

    const payload = JSON.parse(rows(db)[0]!.payload_json!);
    // hasGoal sentinel always present on success; optional metadata absent.
    expect(payload).toEqual({
      agentName: "alpha",
      doneWhen: "llm_judge: tests pass",
      hasGoal: true,
    });
  });

  it("forwards channelChatId and records hasChannelChatId sentinel only", async () => {
    const { client, calls } = fakePool(async () => ({ loop_id: "loop-tg" }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.start"),
    });
    await caller.loops.start({
      agentName: "alpha",
      goal: "noise",
      doneWhen: "manual:",
      channelChatId: "telegram-chat-12345",
    });
    expect((calls[0]!.params as { chat_id?: string }).chat_id).toBe(
      "telegram-chat-12345",
    );
    const payload = JSON.parse(rows(db)[0]!.payload_json!);
    expect(payload.hasChannelChatId).toBe(true);
    // The literal chat id should not be echoed (treat as semi-opaque).
    expect(payload.channelChatId).toBeUndefined();
  });

  it("omits user_id from MCP params when caller is unauthenticated", async () => {
    const { client, calls } = fakePool(async () => ({ loop_id: "loop-anon" }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: null,
      req: makeReq({}, "loops.start"),
    });
    await caller.loops.start({
      agentName: "alpha",
      goal: "x",
      doneWhen: "manual:",
    });
    expect((calls[0]!.params as { user_id?: string }).user_id).toBeUndefined();
    expect(rows(db)[0]!.user_id).toBeNull();
  });
});

describe("loops.start — input validation", () => {
  it("rejects empty goal with BAD_REQUEST and writes no audit row", async () => {
    const { client, calls } = fakePool(async () => ({ loop_id: "loop-1" }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.start"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.start({
        agentName: "alpha",
        goal: "",
        doneWhen: "manual:",
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
    expect(rows(db).length).toBe(0);
  });

  it("rejects goal > 32_000 chars", async () => {
    const { client, calls } = fakePool(async () => ({ loop_id: "loop-1" }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.start"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.start({
        agentName: "alpha",
        goal: "x".repeat(32_001),
        doneWhen: "manual:",
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
  });

  it("rejects empty agentName", async () => {
    const { client } = fakePool(async () => ({ loop_id: "loop-1" }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.start"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.start({
        agentName: "",
        goal: "x",
        doneWhen: "manual:",
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });

  it("rejects malformed doneWhen (no recognized prefix)", async () => {
    const { client, calls } = fakePool(async () => ({ loop_id: "loop-1" }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.start"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.start({
        agentName: "alpha",
        goal: "x",
        doneWhen: "wrong-prefix: anything",
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
  });

  it("accepts every documented doneWhen prefix", async () => {
    const prefixes = [
      "command: bun test",
      "file_exists: /tmp/done",
      "file_contains: README.md OK",
      "llm_judge: tests pass",
      "manual:",
    ];
    for (const doneWhen of prefixes) {
      const { client } = fakePool(async () => ({ loop_id: `loop-${doneWhen.slice(0, 4)}` }));
      const caller = appRouter.createCaller({
        mcp: client,
        userId: "owner",
        req: makeReq({}, "loops.start"),
      });
      const out = await caller.loops.start({
        agentName: "alpha",
        goal: "x",
        doneWhen,
      });
      expect(out.loopId).toMatch(/^loop-/);
    }
  });

  it("rejects out-of-range maxIterations", async () => {
    const { client, calls } = fakePool(async () => ({ loop_id: "loop-1" }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.start"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.start({
        agentName: "alpha",
        goal: "x",
        doneWhen: "manual:",
        maxIterations: 0,
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
  });

  it("rejects negative or zero maxCostUsd", async () => {
    const { client } = fakePool(async () => ({ loop_id: "loop-1" }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.start"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.start({
        agentName: "alpha",
        goal: "x",
        doneWhen: "manual:",
        maxCostUsd: 0,
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });
});

describe("loops.start — malformed daemon response", () => {
  it("throws INTERNAL_SERVER_ERROR and audits malformed_response", async () => {
    const { client } = fakePool(async () => ({ ok: true })); // no loop_id, no content
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.start"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.start({
        agentName: "alpha",
        goal: "secret-goal-text",
        doneWhen: "manual:",
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    expect(caught!.message).toMatch(/malformed/i);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("loop.start.error");
    expect(all[0]!.resource_id).toBeNull();
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload.code).toBe("malformed_response");
    expect(payload.agentName).toBe("alpha");
    // Privacy on the error path too.
    expect(all[0]!.payload_json).not.toContain("secret-goal-text");
  });

  it("throws on text envelope without a 'Started loop X' line", async () => {
    const { client } = fakePool(async () => ({
      content: [{ type: "text", text: "Loop creation failed: agent busy" }],
    }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.start"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.start({
        agentName: "alpha",
        goal: "x",
        doneWhen: "manual:",
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("loops.start — MCP error mapping", () => {
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
        req: makeReq({}, "loops.start"),
      });
      let caught: TRPCError | null = null;
      try {
        await caller.loops.start({
          agentName: "alpha",
          goal: "private goal text",
          doneWhen: "manual:",
        });
      } catch (e) {
        caught = e as TRPCError;
      }
      expect(caught).toBeInstanceOf(TRPCError);
      expect(caught!.code).toBe(c.trpcCode);

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("loop.start.error");
      expect(all[0]!.resource_id).toBeNull();
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload.code).toBe(c.poolCode);
      expect(payload.agentName).toBe("alpha");
      // Privacy on every error branch.
      expect(all[0]!.payload_json).not.toContain("private goal text");
    });
  }
});

describe("loops.start — MCP context missing", () => {
  it("returns INTERNAL_SERVER_ERROR when no MCP client wired", async () => {
    const caller = appRouter.createCaller({ userId: "owner", req: makeReq({}, "loops.start") });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.start({
        agentName: "alpha",
        goal: "x",
        doneWhen: "manual:",
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    // No audit row — context guard fires before the audit envelope.
    expect(rows(db).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P3-T4 — loops.cancel (mutation, calls bridge_loop_cancel)
// ─────────────────────────────────────────────────────────────────────
//
// Same shape as approve/reject: tmp on-disk DB so the procedure can
// resolve the loop row to derive `status` + idempotency, plus a fake
// MCP client per test. The headline is the multi-channel race: a
// dashboard-side cancel can land while Telegram is finalizing the
// loop — both the server-side terminal-status check and the
// daemon-side regex map to the same `alreadyFinalized:true` shape.

describe("loops.cancel — happy path", () => {
  it("running loop → calls bridge_loop_cancel and returns alreadyFinalized:false", async () => {
    seedLoop(db, { loopId: "loop-c1", status: "running", pendingApproval: false });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const req = makeReq({ "x-forwarded-for": "5.6.7.8", "user-agent": "ua/1" }, "loops.cancel");

    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req });
    const out = await caller.loops.cancel({ loopId: "loop-c1" });
    expect(out).toEqual({ ok: true, alreadyFinalized: false });

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("bridge_loop_cancel");
    expect(calls[0]!.params).toEqual({ loop_id: "loop-c1" });
    expect(calls[0]!.opts?.timeoutMs).toBe(15_000);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("loop.cancel");
    expect(all[0]!.resource_type).toBe("loop");
    expect(all[0]!.resource_id).toBe("loop-c1");
    expect(all[0]!.user_id).toBe("owner");
    expect(all[0]!.ip_hash).not.toBeNull();
    expect(all[0]!.user_agent).toBe("ua/1");
    expect(all[0]!.request_id).toMatch(/^[0-9a-f-]{36}$/);
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload).toEqual({
      status: "running",
      alreadyFinalized: false,
    });
  });

  it("loop in pending_approval (still 'running') is cancellable", async () => {
    seedLoop(db, { loopId: "loop-pa", status: "running", pendingApproval: true });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.cancel"),
    });
    const out = await caller.loops.cancel({ loopId: "loop-pa" });
    expect(out).toEqual({ ok: true, alreadyFinalized: false });
    expect(calls.length).toBe(1);
  });
});

describe("loops.cancel — already finalized (server-side check, no MCP call)", () => {
  for (const status of ["done", "cancelled", "canceled", "failed"] as const) {
    it(`status=${status} → alreadyFinalized:true without MCP`, async () => {
      seedLoop(db, { loopId: `loop-${status}`, status, pendingApproval: false });
      const { client, calls } = fakePool(async () => ({ ok: true }));
      const caller = appRouter.createCaller({
        mcp: client,
        userId: "owner",
        req: makeReq({}, "loops.cancel"),
      });
      const out = await caller.loops.cancel({ loopId: `loop-${status}` });
      expect(out).toEqual({ ok: true, alreadyFinalized: true });
      expect(calls.length).toBe(0);

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("loop.cancel");
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload.status).toBe(status);
      expect(payload.alreadyFinalized).toBe(true);
      // Race detection only fires on the daemon-error path — server-
      // side terminal short-circuit must NOT carry that flag.
      expect(payload.raceDetected).toBeUndefined();
    });
  }
});

describe("loops.cancel — daemon race (MCP_RPC_ERROR with race-pattern message)", () => {
  const racePatterns = [
    "loop already approved",
    "loop already rejected",
    "already finalized",
    "loop not pending approval",
    "not pending approval",
    "already finished",
    "already cancelled",
    "already canceled",
    "already done",
  ];

  for (const message of racePatterns) {
    it(`swallows "${message}" → alreadyFinalized:true`, async () => {
      seedLoop(db, { loopId: "loop-c-race", status: "running", pendingApproval: false });
      const { client } = fakePool(async () => {
        throw new McpPoolError("MCP_RPC_ERROR", message);
      });
      const caller = appRouter.createCaller({
        mcp: client,
        userId: "owner",
        req: makeReq({}, "loops.cancel"),
      });
      const out = await caller.loops.cancel({ loopId: "loop-c-race" });
      expect(out).toEqual({ ok: true, alreadyFinalized: true });

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("loop.cancel");
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload.alreadyFinalized).toBe(true);
      expect(payload.raceDetected).toBe(true);
      expect(payload.status).toBe("running");
    });
  }

  it("does NOT swallow generic MCP_RPC_ERROR (e.g. agent panic)", async () => {
    seedLoop(db, { loopId: "loop-c-panic", status: "running", pendingApproval: false });
    const { client } = fakePool(async () => {
      throw new McpPoolError("MCP_RPC_ERROR", "daemon panic: out of memory");
    });
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.cancel"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.cancel({ loopId: "loop-c-panic" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("loop.cancel.error");
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload.code).toBe("MCP_RPC_ERROR");
    expect(payload.status).toBe("running");
  });
});

describe("loops.cancel — loop not found", () => {
  it("unknown loopId → NOT_FOUND, no audit row, no MCP call", async () => {
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.cancel"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.cancel({ loopId: "ghost" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("NOT_FOUND");
    expect(calls.length).toBe(0);
    expect(rows(db).length).toBe(0);
  });
});

describe("loops.cancel — input validation", () => {
  it("rejects empty loopId with BAD_REQUEST", async () => {
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.cancel"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.cancel({ loopId: "" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
    expect(rows(db).length).toBe(0);
  });

  it("rejects oversize loopId (>128 chars)", async () => {
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.cancel"),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.cancel({ loopId: "x".repeat(129) });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
  });
});

describe("loops.cancel — MCP error mapping", () => {
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
      name: "MCP_ABORTED → CLIENT_CLOSED_REQUEST",
      poolCode: "MCP_ABORTED",
      trpcCode: "CLIENT_CLOSED_REQUEST",
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      seedLoop(db, { loopId: "loop-c-err", status: "running", pendingApproval: false });
      const { client } = fakePool(async () => {
        throw new McpPoolError(c.poolCode, "boom");
      });
      const caller = appRouter.createCaller({
        mcp: client,
        userId: "owner",
        req: makeReq({}, "loops.cancel"),
      });
      let caught: TRPCError | null = null;
      try {
        await caller.loops.cancel({ loopId: "loop-c-err" });
      } catch (e) {
        caught = e as TRPCError;
      }
      expect(caught).toBeInstanceOf(TRPCError);
      expect(caught!.code).toBe(c.trpcCode);

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("loop.cancel.error");
      expect(all[0]!.resource_id).toBe("loop-c-err");
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload.code).toBe(c.poolCode);
      expect(payload.status).toBe("running");
    });
  }
});

describe("loops.cancel — context propagation", () => {
  it("writes user_id=null when caller is unauthenticated", async () => {
    seedLoop(db, { loopId: "loop-c-anon", status: "running", pendingApproval: false });
    const { client } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: null,
      req: makeReq({}, "loops.cancel"),
    });
    await caller.loops.cancel({ loopId: "loop-c-anon" });
    expect(rows(db)[0]!.user_id).toBeNull();
  });
});

describe("loops.cancel — MCP context missing", () => {
  it("returns INTERNAL_SERVER_ERROR when no MCP client wired", async () => {
    seedLoop(db, { loopId: "loop-c-no-mcp", status: "running", pendingApproval: false });
    const caller = appRouter.createCaller({ userId: "owner", req: makeReq({}, "loops.cancel") });
    let caught: TRPCError | null = null;
    try {
      await caller.loops.cancel({ loopId: "loop-c-no-mcp" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    expect(rows(db).length).toBe(0);
  });
});

describe("loops.cancel — repeated call idempotency", () => {
  it("first cancel succeeds; second cancel (status flipped) is alreadyFinalized", async () => {
    seedLoop(db, { loopId: "loop-c-rep", status: "running", pendingApproval: false });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({}, "loops.cancel"),
    });

    const first = await caller.loops.cancel({ loopId: "loop-c-rep" });
    expect(first).toEqual({ ok: true, alreadyFinalized: false });
    expect(calls.length).toBe(1);

    db.prepare("UPDATE loops SET status = 'cancelled' WHERE loop_id = ?").run("loop-c-rep");

    const second = await caller.loops.cancel({ loopId: "loop-c-rep" });
    expect(second).toEqual({ ok: true, alreadyFinalized: true });
    // No second MCP call — server-side terminal-status check short-circuited.
    expect(calls.length).toBe(1);

    const all = rows(db);
    expect(all.length).toBe(2);
    expect(all[0]!.action).toBe("loop.cancel");
    expect(all[1]!.action).toBe("loop.cancel");
    expect(JSON.parse(all[0]!.payload_json!).alreadyFinalized).toBe(false);
    expect(JSON.parse(all[1]!.payload_json!).alreadyFinalized).toBe(true);
  });
});
