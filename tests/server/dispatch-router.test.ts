// T01 — integration tests for the `tasks.dispatch` tRPC mutation. The
// router is exercised through `appRouter.createCaller(ctx)` with an
// injected fake MCP client (no real spawn) and a tmp SQLite DB whose
// `audit_log` is created via the migration runner. This is the same
// shape `audit-integrations.test.ts` uses for the entry-guard
// integrations.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { TRPCError } from "@trpc/server";

import { appRouter } from "../../src/server/routers/_app";
import { runMigrations } from "../../src/server/migrate";
import {
  __resetAudit,
  __setAuditDb,
} from "../../src/server/audit";
import {
  McpPoolError,
  type CallOptions,
  type McpClient,
} from "../../src/server/mcp/pool";

const ORIGINAL_ENV = { ...process.env };

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
  return new Request("http://localhost/api/trpc/tasks.dispatch", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

let db: Database;

beforeEach(() => {
  process.env.JWT_SECRET = "dispatch-test-secret-please-do-not-use-in-prod";
  process.env.AUDIT_IP_HASH_SALT = "salty";
  db = new Database(":memory:");
  runMigrations(db);
  __resetAudit();
  __setAuditDb(db);
});

afterEach(() => {
  __setAuditDb(null);
  __resetAudit();
  db.close();
  for (const key of ["JWT_SECRET", "AUDIT_IP_HASH_SALT"] as const) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key]!;
  }
});

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

describe("tasks.dispatch — happy path", () => {
  it("returns { taskId } and writes one task.dispatch audit row", async () => {
    const { client, calls } = fakePool(async () => ({ task_id: 42 }));
    const req = makeReq({ "x-forwarded-for": "5.6.7.8", "user-agent": "ua/1" });

    const caller = appRouter.createCaller({ mcp: client, userId: "owner", req });
    const out = await caller.tasks.dispatch({
      agentName: "alpha",
      prompt: "do it",
      model: "sonnet",
    });
    expect(out).toEqual({ taskId: 42 });

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("bridge_dispatch");
    expect(calls[0]!.params).toEqual({
      agent: "alpha",
      prompt: "do it",
      model: "sonnet",
    });
    // 15s default timeout passed on every call.
    expect(calls[0]!.opts?.timeoutMs).toBe(15_000);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("task.dispatch");
    expect(all[0]!.resource_type).toBe("task");
    expect(all[0]!.resource_id).toBe("42");
    expect(all[0]!.user_id).toBe("owner");
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload).toEqual({ agentName: "alpha", model: "sonnet" });
    expect(all[0]!.ip_hash).not.toBeNull();
    expect(all[0]!.user_agent).toBe("ua/1");
    expect(all[0]!.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("omits `model` from the MCP params when not provided", async () => {
    const { client, calls } = fakePool(async () => ({ task_id: 7 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq(),
    });
    const out = await caller.tasks.dispatch({
      agentName: "alpha",
      prompt: "no model",
    });
    expect(out).toEqual({ taskId: 7 });
    expect(calls[0]!.params).toEqual({ agent: "alpha", prompt: "no model" });
    const all = rows(db);
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload.agentName).toBe("alpha");
    expect(payload.model).toBeUndefined();
  });

  it("round-trips multi-line / unicode prompts byte-identically", async () => {
    const gnarly = "line1\nline2\n  with\ttabs\nemoji 🎉\n\"quoted\"\\backslash";
    const { client, calls } = fakePool(async () => ({ task_id: 99 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq(),
    });
    await caller.tasks.dispatch({ agentName: "alpha", prompt: gnarly });
    const params = calls[0]!.params as { prompt: string };
    expect(params.prompt).toBe(gnarly);
  });

  it("rejects unauthenticated caller with UNAUTHORIZED + audits rbac_denied (P4-T03)", async () => {
    const { client, calls } = fakePool(async () => ({ task_id: 1 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: null,
      req: makeReq(),
    });
    await expect(
      caller.tasks.dispatch({ agentName: "alpha", prompt: "anon" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(calls.length).toBe(0);
    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("rbac_denied");
    expect(all[0]!.resource_type).toBe("tasks.dispatch");
    expect(all[0]!.user_id).toBeNull();
  });
});

describe("tasks.dispatch — input validation", () => {
  it("rejects empty prompt with BAD_REQUEST and writes no audit row", async () => {
    const { client, calls } = fakePool(async () => ({ task_id: 1 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq(),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.tasks.dispatch({ agentName: "alpha", prompt: "" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
    expect(rows(db).length).toBe(0);
  });

  it("rejects empty agentName with BAD_REQUEST", async () => {
    const { client } = fakePool(async () => ({ task_id: 1 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq(),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.tasks.dispatch({ agentName: "", prompt: "x" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
  });

  it("rejects prompts > 32_000 chars", async () => {
    const { client, calls } = fakePool(async () => ({ task_id: 1 }));
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq(),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.tasks.dispatch({
        agentName: "alpha",
        prompt: "x".repeat(32_001),
      });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(calls.length).toBe(0);
  });
});

describe("tasks.dispatch — malformed daemon response", () => {
  it("throws INTERNAL_SERVER_ERROR and audits malformed_response", async () => {
    const { client } = fakePool(async () => ({ ok: true })); // no task_id
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq(),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.tasks.dispatch({ agentName: "alpha", prompt: "do it" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    expect(caught!.message).toMatch(/malformed/i);

    const all = rows(db);
    expect(all.length).toBe(1);
    expect(all[0]!.action).toBe("task.dispatch.error");
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload.code).toBe("malformed_response");
    expect(payload.agentName).toBe("alpha");
  });
});

describe("tasks.dispatch — MCP error mapping", () => {
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
        req: makeReq(),
      });
      let caught: TRPCError | null = null;
      try {
        await caller.tasks.dispatch({ agentName: "alpha", prompt: "do it" });
      } catch (e) {
        caught = e as TRPCError;
      }
      expect(caught).toBeInstanceOf(TRPCError);
      expect(caught!.code).toBe(c.trpcCode);

      const all = rows(db);
      expect(all.length).toBe(1);
      expect(all[0]!.action).toBe("task.dispatch.error");
      expect(all[0]!.resource_id).toBeNull();
      const payload = JSON.parse(all[0]!.payload_json!);
      expect(payload.code).toBe(c.poolCode);
      expect(payload.agentName).toBe("alpha");
    });
  }

  it("MCP_RPC_ERROR preserves the daemon error message in the tRPC error", async () => {
    const { client } = fakePool(async () => {
      throw new McpPoolError("MCP_RPC_ERROR", "agent not found: alpha");
    });
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq(),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.tasks.dispatch({ agentName: "alpha", prompt: "do it" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.message).toContain("agent not found: alpha");
  });

  it("non-pool errors degrade to INTERNAL_SERVER_ERROR / 'unexpected'", async () => {
    const { client } = fakePool(async () => {
      throw new TypeError("bad shape");
    });
    const caller = appRouter.createCaller({
      mcp: client,
      userId: "owner",
      req: makeReq(),
    });
    let caught: TRPCError | null = null;
    try {
      await caller.tasks.dispatch({ agentName: "alpha", prompt: "do it" });
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");

    const all = rows(db);
    expect(all.length).toBe(1);
    const payload = JSON.parse(all[0]!.payload_json!);
    expect(payload.code).toBe("unexpected");
  });
});
