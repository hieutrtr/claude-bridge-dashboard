// P4-T03 — RBAC matrix grid (the 12 × 4 = 48-case "403 matrix"
// referenced in `docs/tasks/phase-4/INDEX.md` and the loop prompt).
//
// Each row covers one procedure, each column covers one caller role:
//
//                                ┌── Anonymous (no session)
//                                │   ┌── Member acting on own resource
//                                │   │   ┌── Member acting on someone else's
//                                │   │   │   ┌── Owner
//   agents.list             ── 401 200 200 200    ◀── read; authed
//   agents.get              ── 401 200 200 200    ◀── read; authed
//   tasks.dispatch          ── 401 200 200 200    ◀── mutation; authed
//   tasks.kill              ── 401 200 403 200    ◀── mutation; own-or-owner
//   loops.start             ── 401 200 200 200    ◀── mutation; authed
//   loops.cancel            ── 401 200 403 200    ◀── mutation; own-or-owner
//   schedules.add           ── 401 200 200 200    ◀── mutation; authed
//   schedules.remove        ── 401 200 403 200    ◀── mutation; own-or-owner
//   users.list              ── 401 403 403 200    ◀── query; owner
//   users.invite            ── 401 403 403 200    ◀── mutation; owner
//   audit.list              ── 401 403 403 200    ◀── query; owner
//   auth.me                 ── null 200 200 200   ◀── carve-out: anon → null
//                                                      (not 401) for graceful
//                                                      logged-out UI; everything
//                                                      else routes through the
//                                                      authed/owner middleware.
//
// "Member (own)" = member acting on a resource whose `user_id ===
// caller.id`. "Member (other)" = member acting on a resource whose
// `user_id` is a different user. The legacy carve-out (NULL `user_id`)
// is exercised in `rbac.test.ts` for the helper directly; the matrix
// here pins the mutation procedures so a regression that drops the
// own-or-owner check is caught.
//
// Daemon-side DDL is inlined (mirrors `schedules-router.test.ts`) so
// `getSqlite()` returns one handle that already has both the
// dashboard-owned tables (audit_log, users, magic_links — created by
// the migration runner) AND the daemon-owned tables (agents, tasks,
// loops, schedules) we need to seed for the own-resource carve-outs.
//
// MCP is faked — we never spawn a child. Mutation paths that would
// have called the daemon assert success when the RBAC + carve-out
// pass; they bail with `INTERNAL_SERVER_ERROR` if MCP wasn't injected
// (we always inject for the mutation rows).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appRouter } from "../../src/server/routers/_app";
import { resetDb, getSqlite } from "../../src/server/db";
import { __resetAudit, __setAuditDb } from "../../src/server/audit";
import {
  type CallOptions,
  type McpClient,
} from "../../src/server/mcp/pool";

const DAEMON_DDL = `
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
  CREATE TABLE IF NOT EXISTS loops (
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
  CREATE TABLE IF NOT EXISTS schedules (
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
  CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    command TEXT,
    description TEXT,
    status TEXT DEFAULT 'pending',
    response TEXT,
    created_at NUMERIC DEFAULT CURRENT_TIMESTAMP,
    responded_at NUMERIC,
    timeout_seconds INTEGER DEFAULT 300
  );
`;

const ORIGINAL_ENV = { ...process.env };

// Seeded ids reused across the matrix.
const OWNER_ID = "u-owner";
const MEMBER_ID = "u-member";
const OTHER_MEMBER_ID = "u-other";
const SESSION_ID = "session-alpha";
const AGENT_NAME = "alpha";
const PROJECT_DIR = "/tmp/proj-alpha";

interface SeedRow {
  taskOwn: number;
  taskOther: number;
  loopOwn: string;
  loopOther: string;
  scheduleOwn: number;
  scheduleOther: number;
}

let tmpDir: string;
let dbPath: string;
let db: Database;
let seeded: SeedRow;

function makeReq(method = "POST"): Request {
  return new Request("http://localhost/api/trpc/test", {
    method,
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

interface RecordedCall {
  method: string;
  params: unknown;
  opts?: CallOptions;
}

function fakeMcp(): { client: McpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    client: {
      call(method, params, opts) {
        const c: RecordedCall = { method, params, opts };
        calls.push(c);
        // Return shapes the routers expect on success. Each router's
        // success extractor only reads the field it needs.
        if (method === "bridge_dispatch") return Promise.resolve({ task_id: 999 });
        if (method === "bridge_loop") return Promise.resolve({ loop_id: "loop-z" });
        if (method === "bridge_schedule_add") return Promise.resolve({ id: 999 });
        return Promise.resolve({ ok: true });
      },
    },
    calls,
  };
}

function seedAll(): SeedRow {
  // Users — env-owner sub "owner" doesn't need a row (synthetic).
  // Real owner row is OWNER_ID; member rows are MEMBER_ID + OTHER_MEMBER_ID.
  db.prepare(
    `INSERT INTO users (id, email, role, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(OWNER_ID, "owner@example.com", "owner", Date.now());
  db.prepare(
    `INSERT INTO users (id, email, role, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(MEMBER_ID, "member@example.com", "member", Date.now());
  db.prepare(
    `INSERT INTO users (id, email, role, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(OTHER_MEMBER_ID, "other@example.com", "member", Date.now());

  // Daemon-owned: an agent + tasks + loops + schedules.
  db.prepare(
    `INSERT INTO agents (name, project_dir, session_id, agent_file)
     VALUES (?, ?, ?, ?)`,
  ).run(AGENT_NAME, PROJECT_DIR, SESSION_ID, "alpha.md");

  const taskOwnInfo = db.prepare(
    `INSERT INTO tasks (session_id, prompt, status, user_id) VALUES (?, ?, ?, ?)`,
  ).run(SESSION_ID, "own", "running", MEMBER_ID);
  const taskOwn = Number(taskOwnInfo.lastInsertRowid);

  const taskOtherInfo = db.prepare(
    `INSERT INTO tasks (session_id, prompt, status, user_id) VALUES (?, ?, ?, ?)`,
  ).run(SESSION_ID, "other", "running", OTHER_MEMBER_ID);
  const taskOther = Number(taskOtherInfo.lastInsertRowid);

  db.prepare(
    `INSERT INTO loops
       (loop_id, agent, project, goal, done_when, total_cost_usd,
        pending_approval, started_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "loop-own",
    AGENT_NAME,
    PROJECT_DIR,
    "g",
    "manual:",
    0,
    0,
    new Date().toISOString(),
    MEMBER_ID,
  );
  db.prepare(
    `INSERT INTO loops
       (loop_id, agent, project, goal, done_when, total_cost_usd,
        pending_approval, started_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "loop-other",
    AGENT_NAME,
    PROJECT_DIR,
    "g",
    "manual:",
    0,
    0,
    new Date().toISOString(),
    OTHER_MEMBER_ID,
  );

  const sOwnInfo = db.prepare(
    `INSERT INTO schedules (name, agent_name, prompt, interval_minutes, user_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("sched-own", AGENT_NAME, "p", 60, MEMBER_ID);
  const scheduleOwn = Number(sOwnInfo.lastInsertRowid);

  const sOtherInfo = db.prepare(
    `INSERT INTO schedules (name, agent_name, prompt, interval_minutes, user_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("sched-other", AGENT_NAME, "p", 60, OTHER_MEMBER_ID);
  const scheduleOther = Number(sOtherInfo.lastInsertRowid);

  return {
    taskOwn,
    taskOther,
    loopOwn: "loop-own",
    loopOther: "loop-other",
    scheduleOwn,
    scheduleOther,
  };
}

beforeEach(() => {
  process.env.JWT_SECRET = "rbac-matrix-test-secret";
  process.env.AUDIT_IP_HASH_SALT = "rbac-matrix-test-salt";
  tmpDir = mkdtempSync(join(tmpdir(), "rbac-matrix-test-"));
  dbPath = join(tmpDir, "bridge.db");
  process.env.BRIDGE_DB = dbPath;
  resetDb();
  db = getSqlite();
  // Add daemon tables on top of the dashboard migrations.
  db.exec(DAEMON_DDL);
  __resetAudit();
  __setAuditDb(db);
  seeded = seedAll();
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
    "OWNER_EMAIL",
  ] as const) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key]!;
  }
});

type CallerRole = "anonymous" | "member-own" | "member-other" | "owner";

function ctxFor(role: CallerRole, mcp?: McpClient) {
  const base: { req: Request; mcp?: McpClient; userId: string | null } = {
    req: makeReq(),
    userId: null,
  };
  if (mcp) base.mcp = mcp;
  switch (role) {
    case "anonymous":
      base.userId = null;
      break;
    case "member-own":
      base.userId = MEMBER_ID;
      break;
    case "member-other":
      base.userId = MEMBER_ID; // same member, but acts on a row owned by OTHER_MEMBER_ID
      break;
    case "owner":
      base.userId = OWNER_ID;
      break;
  }
  return base;
}

type Verdict = "UNAUTHORIZED" | "FORBIDDEN" | "OK" | "NULL";

async function verdict(
  fn: () => Promise<unknown>,
): Promise<{ status: Verdict; result?: unknown; code?: string }> {
  try {
    const result = await fn();
    if (result === null) return { status: "NULL", result };
    return { status: "OK", result };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "UNAUTHORIZED") return { status: "UNAUTHORIZED", code };
    if (code === "FORBIDDEN") return { status: "FORBIDDEN", code };
    throw e;
  }
}

interface MatrixCase {
  procedure: string;
  invoke: (role: CallerRole) => Promise<unknown>;
  expected: Record<CallerRole, Verdict>;
}

function readRbacDeniedRoutes(): string[] {
  return (
    db
      .prepare(
        `SELECT resource_type FROM audit_log
          WHERE action = 'rbac_denied' ORDER BY id ASC`,
      )
      .all() as Array<{ resource_type: string }>
  ).map((r) => r.resource_type);
}

// Helper: build a caller for the given role, auto-injecting the fake
// MCP client when the procedure is a mutation that needs it.
function caller(role: CallerRole, mcp?: McpClient) {
  return appRouter.createCaller(ctxFor(role, mcp));
}

// =============================================================
// Matrix rows. Each `invoke` calls the procedure for the given role.
// =============================================================

function matrix(): MatrixCase[] {
  return [
    {
      procedure: "agents.list",
      invoke: (role) => caller(role).agents.list(),
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "OK",
        "member-other": "OK",
        owner: "OK",
      },
    },
    {
      procedure: "agents.get",
      invoke: (role) => caller(role).agents.get({ name: AGENT_NAME }),
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "OK",
        "member-other": "OK",
        owner: "OK",
      },
    },
    {
      procedure: "tasks.dispatch",
      invoke: (role) => {
        const { client } = fakeMcp();
        return caller(role, client).tasks.dispatch({
          agentName: AGENT_NAME,
          prompt: "hi",
        });
      },
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "OK",
        "member-other": "OK", // dispatch doesn't touch a pre-existing resource → no own-check
        owner: "OK",
      },
    },
    {
      procedure: "tasks.kill (own)",
      invoke: (role) => {
        const { client } = fakeMcp();
        return caller(role, client).tasks.kill({ id: seeded.taskOwn });
      },
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "OK",
        "member-other": "OK", // member acting on tasks they own
        owner: "OK",
      },
    },
    {
      procedure: "tasks.kill (other)",
      invoke: (role) => {
        const { client } = fakeMcp();
        return caller(role, client).tasks.kill({ id: seeded.taskOther });
      },
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "FORBIDDEN", // member acting on someone else's task
        "member-other": "FORBIDDEN",
        owner: "OK",
      },
    },
    {
      procedure: "loops.start",
      invoke: (role) => {
        const { client } = fakeMcp();
        return caller(role, client).loops.start({
          agentName: AGENT_NAME,
          goal: "g",
          doneWhen: "manual:",
        });
      },
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "OK",
        "member-other": "OK",
        owner: "OK",
      },
    },
    {
      procedure: "loops.cancel (own)",
      invoke: (role) => {
        const { client } = fakeMcp();
        return caller(role, client).loops.cancel({ loopId: seeded.loopOwn });
      },
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "OK",
        "member-other": "OK",
        owner: "OK",
      },
    },
    {
      procedure: "loops.cancel (other)",
      invoke: (role) => {
        const { client } = fakeMcp();
        return caller(role, client).loops.cancel({ loopId: seeded.loopOther });
      },
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "FORBIDDEN",
        "member-other": "FORBIDDEN",
        owner: "OK",
      },
    },
    {
      procedure: "schedules.add",
      invoke: (role) => {
        const { client } = fakeMcp();
        return caller(role, client).schedules.add({
          agentName: AGENT_NAME,
          prompt: "p",
          intervalMinutes: 60,
        });
      },
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "OK",
        "member-other": "OK",
        owner: "OK",
      },
    },
    {
      procedure: "schedules.remove (own)",
      invoke: (role) => {
        const { client } = fakeMcp();
        return caller(role, client).schedules.remove({ id: seeded.scheduleOwn });
      },
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "OK",
        "member-other": "OK",
        owner: "OK",
      },
    },
    {
      procedure: "schedules.remove (other)",
      invoke: (role) => {
        const { client } = fakeMcp();
        return caller(role, client).schedules.remove({ id: seeded.scheduleOther });
      },
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "FORBIDDEN",
        "member-other": "FORBIDDEN",
        owner: "OK",
      },
    },
    {
      procedure: "users.list",
      invoke: (role) => caller(role).users.list(),
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "FORBIDDEN",
        "member-other": "FORBIDDEN",
        owner: "OK",
      },
    },
    {
      procedure: "users.invite",
      invoke: (role) =>
        caller(role).users.invite({
          email: "newbie@example.com",
          role: "member",
        }),
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "FORBIDDEN",
        "member-other": "FORBIDDEN",
        owner: "OK",
      },
    },
    {
      procedure: "audit.list",
      invoke: (role) => caller(role).audit.list({}),
      expected: {
        anonymous: "UNAUTHORIZED",
        "member-own": "FORBIDDEN",
        "member-other": "FORBIDDEN",
        owner: "OK",
      },
    },
  ];
}

describe("RBAC matrix — every procedure × every role", () => {
  for (const row of matrix()) {
    for (const role of [
      "anonymous",
      "member-own",
      "member-other",
      "owner",
    ] as CallerRole[]) {
      const expected = row.expected[role];
      it(`${row.procedure} :: ${role} → ${expected}`, async () => {
        const got = await verdict(() => row.invoke(role));
        expect(got.status).toBe(expected);
      });
    }
  }
});

describe("RBAC matrix — auth.me carve-out", () => {
  it("auth.me returns null (NOT 401) for anonymous — graceful logged-out state", async () => {
    const out = await caller("anonymous").auth.me();
    expect(out).toBeNull();
  });

  it("auth.me returns the row for owner", async () => {
    const out = await caller("owner").auth.me();
    expect(out).not.toBeNull();
    expect(out!.role).toBe("owner");
  });

  it("auth.me returns the row for member", async () => {
    const out = await caller("member-own").auth.me();
    expect(out).not.toBeNull();
    expect(out!.role).toBe("member");
  });
});

describe("RBAC matrix — audit invariants", () => {
  it("every UNAUTHORIZED + FORBIDDEN denial writes an `rbac_denied` audit row tagged with the requested route", async () => {
    // Run every (procedure × role) cell that is supposed to deny.
    let expectedDenials = 0;
    for (const row of matrix()) {
      for (const role of [
        "anonymous",
        "member-own",
        "member-other",
        "owner",
      ] as CallerRole[]) {
        const want = row.expected[role];
        if (want !== "UNAUTHORIZED" && want !== "FORBIDDEN") continue;
        await verdict(() => row.invoke(role)).catch(() => undefined);
        expectedDenials += 1;
      }
    }
    const denied = readRbacDeniedRoutes();
    // Every denial wrote at least one rbac_denied row. The exact count
    // can be > expectedDenials because some carve-out paths emit two
    // rows (auth gate + own-resource gate) — that's fine, the
    // invariant is "no denial is silent".
    expect(denied.length).toBeGreaterThanOrEqual(expectedDenials);
    // Spot-check: the routes recorded include the procedure paths we
    // exercised (use the unique set so duplicates from re-runs collapse).
    const unique = new Set(denied);
    expect(unique).toContain("agents.list");
    expect(unique).toContain("tasks.dispatch");
    expect(unique).toContain("tasks.kill");
    expect(unique).toContain("loops.start");
    expect(unique).toContain("loops.cancel");
    expect(unique).toContain("schedules.add");
    expect(unique).toContain("schedules.remove");
    expect(unique).toContain("users.list");
    expect(unique).toContain("users.invite");
    expect(unique).toContain("audit.list");
  });

  it("legacy NULL-user_id row is killable by any member (carve-out)", async () => {
    // Insert a legacy task with NULL user_id (pre-Phase-4 CLI rows).
    const info = db
      .prepare(
        `INSERT INTO tasks (session_id, prompt, status, user_id) VALUES (?, ?, ?, NULL)`,
      )
      .run(SESSION_ID, "legacy", "running");
    const legacyId = Number(info.lastInsertRowid);

    const { client } = fakeMcp();
    const out = await caller("member-own", client).tasks.kill({ id: legacyId });
    expect(out).toMatchObject({ ok: true });
  });
});

describe("RBAC matrix — denial does NOT leak via batch", () => {
  it("a tRPC batch where one procedure denies and one allows still reports the denial (no implicit fall-through)", async () => {
    const { client } = fakeMcp();
    // Same caller (member acting on someone else's task) hits two
    // procedures back-to-back. The first must FORBID; the second
    // (a query the member is allowed to read) must succeed. The
    // denial must NOT be swallowed by the second call's success.
    const member = caller("member-own", client);
    let killVerdict: Verdict = "OK";
    try {
      await member.tasks.kill({ id: seeded.taskOther });
    } catch (e) {
      const code = (e as { code?: string }).code;
      killVerdict = code === "FORBIDDEN" ? "FORBIDDEN" : "OK";
    }
    expect(killVerdict).toBe("FORBIDDEN");
    const ok = await member.agents.list();
    expect(Array.isArray(ok)).toBe(true);
    // Audit log records the denial regardless of subsequent successes.
    const routes = readRbacDeniedRoutes();
    expect(routes).toContain("tasks.kill");
  });
});
