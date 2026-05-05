// T03 — integration tests for the `tasks.kill` tRPC mutation. Same
// shape as `dispatch-router.test.ts`: `createCaller` + injected fake
// MCP client. Adds an on-disk tmp DB so the procedure can resolve the
// task → agent join (the dispatch test uses `:memory:` because dispatch
// never reads the tasks table; kill must look up the task to derive
// the agent name for `bridge_kill`).
//
// Idempotency is the headline behaviour: the procedure must turn the
// race "user clicks Kill on a task that just finished" into a friendly
// `{ alreadyTerminated: true }` response — never a confusing 500.

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

// Daemon-owned schema mirror — same shape as analytics-router.test.ts.
// audit_log is created automatically by `runMigrations` inside
// `getSqlite()` once `BRIDGE_DB` points here.
const SCHEMA_DDL = `
  CREATE TABLE agents (
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
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    pid INTEGER,
    result_file TEXT,
    result_summary TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    num_turns INTEGER,
    exit_code INTEGER,
    error_message TEXT,
    created_at NUMERIC DEFAULT CURRENT_TIMESTAMP,
    started_at NUMERIC,
    completed_at NUMERIC,
    reported INTEGER DEFAULT 0,
    position INTEGER,
    model TEXT,
    task_type TEXT DEFAULT 'standard',
    parent_task_id INTEGER,
    channel TEXT DEFAULT 'cli',
    channel_chat_id TEXT,
    channel_message_id TEXT,
    user_id TEXT
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

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/trpc/tasks.kill", {
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

interface SeedTaskOpts {
  id: number;
  agentName: string;
  sessionId?: string;
  status: string;
}

function seedTask(db: Database, opts: SeedTaskOpts): void {
  const sessionId = opts.sessionId ?? `sess-${opts.agentName}`;
  // Idempotent agent seed — same name+project_dir won't conflict.
  db.prepare(
    `INSERT OR IGNORE INTO agents (name, project_dir, session_id, agent_file)
     VALUES (?, ?, ?, ?)`,
  ).run(opts.agentName, `/tmp/${opts.agentName}`, sessionId, `/tmp/${opts.agentName}.md`);
  db.prepare(
    `INSERT INTO tasks (id, session_id, prompt, status)
     VALUES (?, ?, ?, ?)`,
  ).run(opts.id, sessionId, "do thing", opts.status);
}

const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  process.env.JWT_SECRET = "kill-test-secret-please-do-not-use-in-prod";
  process.env.AUDIT_IP_HASH_SALT = "salty-kill";
  tmpDir = mkdtempSync(join(tmpdir(), "kill-router-test-"));
  dbPath = join(tmpDir, "bridge.db");
  // Seed daemon schema before pointing BRIDGE_DB at the file.
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

describe("tasks.kill — happy path (active task)", () => {
  it("running → calls bridge_kill and returns alreadyTerminated:false", async () => {
    seedTask(db, { id: 1, agentName: "alpha", status: "running" });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const req = makeReq({ "x-forwarded-for": "5.6.7.8", "user-agent": "ua/1" });

    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req });
    const out = await caller.tasks.kill({ id: 1 });
    expect(out).toEqual({ ok: true, alreadyTerminated: false });

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("bridge_kill");
    expect(calls[0]!.params).toEqual({ agent: "alpha" });
    expect(calls[0]!.opts?.timeoutMs).toBe(15_000);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("task.kill");
    expect(all[0]!.resource_type).toBe("task");
    expect(all[0]!.resource_id).toBe("1");
    expect(all[0]!.user_id).toBe("owner");
    expect(all[0]!.ip_hash).not.toBeNull();
    expect(all[0]!.user_agent).toBe("ua/1");
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload).toEqual({
      agentName: "alpha",
      status: "running",
      alreadyTerminated: false,
    });
  });

  it("pending → calls bridge_kill (daemon decides whether it's killable)", async () => {
    seedTask(db, { id: 2, agentName: "beta", status: "pending" });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
    const out = await caller.tasks.kill({ id: 2 });
    expect(out).toEqual({ ok: true, alreadyTerminated: false });
    expect(calls.length).toBe(1);
    const payload = JSON.parse(rows(db)[0]!.payload_json!);
    expect(payload.status).toBe("pending");
  });

  it("queued → calls bridge_kill", async () => {
    seedTask(db, { id: 3, agentName: "gamma", status: "queued" });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
    await caller.tasks.kill({ id: 3 });
    expect(calls.length).toBe(1);
    const payload = JSON.parse(rows(db)[0]!.payload_json!);
    expect(payload.status).toBe("queued");
  });
});

describe("tasks.kill — already terminated (server-side check, no MCP call)", () => {
  for (const status of ["done", "failed", "killed"] as const) {
    it(`${status} → returns alreadyTerminated:true without calling MCP`, async () => {
      seedTask(db, { id: 10, agentName: "alpha", status });
      const { client, calls } = fakePool(async () => ({ ok: true }));
      const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
      const out = await caller.tasks.kill({ id: 10 });
      expect(out).toEqual({ ok: true, alreadyTerminated: true });
      expect(calls.length).toBe(0);

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("task.kill");
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload).toEqual({
        agentName: "alpha",
        status,
        alreadyTerminated: true,
      });
    });
  }
});

describe("tasks.kill — daemon race (MCP_RPC_ERROR with race-pattern message)", () => {
  const racePatterns = [
    "no running task on agent alpha",
    "not running",
    "task already terminated",
    "already finished",
    "already killed",
    "already done",
  ];

  for (const message of racePatterns) {
    it(`swallows "${message}" → alreadyTerminated:true`, async () => {
      seedTask(db, { id: 20, agentName: "alpha", status: "running" });
      const { client } = fakePool(async () => {
        throw new McpPoolError("MCP_RPC_ERROR", message);
      });
      const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
      const out = await caller.tasks.kill({ id: 20 });
      expect(out).toEqual({ ok: true, alreadyTerminated: true });

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("task.kill");
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload.alreadyTerminated).toBe(true);
      expect(payload.raceDetected).toBe(true);
      expect(payload.agentName).toBe("alpha");
    });
  }

  it("does NOT swallow generic MCP_RPC_ERROR (e.g. agent panic)", async () => {
    seedTask(db, { id: 21, agentName: "alpha", status: "running" });
    const { client } = fakePool(async () => {
      throw new McpPoolError("MCP_RPC_ERROR", "daemon panic: out of memory");
    });
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
    let caught: TRPCError | null = null;
    try {
      await caller.tasks.kill({ id: 21 });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    expect(caught!.message).toContain("daemon panic");

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("task.kill.error");
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload.code).toBe("MCP_RPC_ERROR");
    expect(payload.agentName).toBe("alpha");
  });
});

describe("tasks.kill — task not found", () => {
  it("unknown id → NOT_FOUND, no audit row, no MCP call", async () => {
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
    let caught: TRPCError | null = null;
    try {
      await caller.tasks.kill({ id: 9999 });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("NOT_FOUND");
    expect(caught!.message).toMatch(/task not found/i);
    expect(calls.length).toBe(0);
    expect(rows(db).length).toBe(0);
  });
});

describe("tasks.kill — input validation", () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    it(`rejects id=${bad} with BAD_REQUEST`, async () => {
      const { client, calls } = fakePool(async () => ({ ok: true }));
      const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
      let caught: TRPCError | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await caller.tasks.kill({ id: bad as any });
      } catch (e) {
        caught = e as TRPCError;
      }
      expect(caught!.code).toBe("BAD_REQUEST");
      expect(calls.length).toBe(0);
      expect(rows(db).length).toBe(0);
    });
  }
});

describe("tasks.kill — MCP error mapping", () => {
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
      seedTask(db, { id: 30, agentName: "alpha", status: "running" });
      const { client } = fakePool(async () => {
        throw new McpPoolError(c.poolCode, "boom");
      });
      const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });
      let caught: TRPCError | null = null;
      try {
        await caller.tasks.kill({ id: 30 });
      } catch (e) {
        caught = e as TRPCError;
      }
      expect(caught).toBeInstanceOf(TRPCError);
      expect(caught!.code).toBe(c.trpcCode);

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("task.kill.error");
      expect(all[0]!.resource_id).toBe("30");
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload.code).toBe(c.poolCode);
      expect(payload.agentName).toBe("alpha");
    });
  }
});

describe("tasks.kill — context propagation", () => {
  it("writes user_id=null when caller is unauthenticated", async () => {
    seedTask(db, { id: 40, agentName: "alpha", status: "running" });
    const { client } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({ mcp: client, userId: null, req: makeReq() });
    await caller.tasks.kill({ id: 40 });
    expect(rows(db)[0]!.user_id).toBeNull();
  });

  it("writes ip_hash when x-forwarded-for is present", async () => {
    seedTask(db, { id: 41, agentName: "alpha", status: "running" });
    const { client } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq({ "x-forwarded-for": "5.6.7.8" }),
    });
    await caller.tasks.kill({ id: 41 });
    expect(rows(db)[0]!.ip_hash).not.toBeNull();
  });
});

describe("tasks.kill — repeated call idempotency", () => {
  it("first kill succeeds; second kill (after status flips to killed) is alreadyTerminated", async () => {
    seedTask(db, { id: 50, agentName: "alpha", status: "running" });
    const { client, calls } = fakePool(async () => ({ ok: true }));
    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req: makeReq() });

    const first = await caller.tasks.kill({ id: 50 });
    expect(first).toEqual({ ok: true, alreadyTerminated: false });
    expect(calls.length).toBe(1);

    // Simulate the daemon updating the row after the kill landed.
    db.prepare("UPDATE tasks SET status = 'killed' WHERE id = ?").run(50);

    const second = await caller.tasks.kill({ id: 50 });
    expect(second).toEqual({ ok: true, alreadyTerminated: true });
    // Still only one MCP call — the second hit the early-return path.
    expect(calls.length).toBe(1);

    const all = rows(db);
    expect(all.length).toBe(2);
    expect(all[0]!.action).toBe("task.kill");
    expect(all[1]!.action).toBe("task.kill");
    expect(JSON.parse(all[0]!.payload_json!).alreadyTerminated).toBe(false);
    expect(JSON.parse(all[1]!.payload_json!).alreadyTerminated).toBe(true);
  });
});
