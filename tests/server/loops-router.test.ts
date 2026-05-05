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
