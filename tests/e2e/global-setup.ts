// T13 — Playwright global setup. Builds a deterministic SQLite fixture
// + JSONL transcript before the dev server boots, so the smoke spec
// always finds the same agent/task/result regardless of the user's host
// `~/.claude-bridge/` state.
//
// Read-only invariant: this file *writes to disk* but only inside
// `tests/e2e/.fixture/`. It does not call any tRPC mutation, dispatch a
// task, or touch the daemon. The smoke spec itself remains read-only.
//
// `playwright.config.ts` reads the produced paths/values out of env
// vars; we set those before the webServer.command runs. Returning a
// teardown function would let us delete the fixture afterwards, but we
// keep it on disk so a debugging dev can `bun run dev` against the same
// seeded data.

import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  FIXTURE_AGENT,
  FIXTURE_CLAUDE_HOME,
  FIXTURE_DB,
  FIXTURE_DIR,
  FIXTURE_JWT_SECRET,
  FIXTURE_LOOP_PENDING_APPROVAL,
  FIXTURE_LOOP_RUNNING,
  FIXTURE_PASSWORD,
  FIXTURE_SCHEDULE,
} from "./fixture";

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
    last_run_at NUMERIC,
    next_run_at NUMERIC,
    last_error TEXT,
    channel TEXT DEFAULT 'cli',
    channel_chat_id TEXT,
    user_id TEXT,
    created_at NUMERIC DEFAULT CURRENT_TIMESTAMP,
    updated_at NUMERIC DEFAULT CURRENT_TIMESTAMP
  );
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
    total_cost_usd REAL NOT NULL,
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
    cost_usd REAL NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running'
  );
`;

function projectSlug(projectDir: string): string {
  return projectDir.replace(/\//g, "-");
}

export default async function globalSetup(): Promise<void> {
  if (existsSync(FIXTURE_DIR)) {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });

  const dbPath = FIXTURE_DB;
  const claudeHome = FIXTURE_CLAUDE_HOME;

  // Seed SQLite: 1 agent, 2 tasks (one done with cost so /cost has data,
  // one running so the table has > 1 row).
  const sqlite = new Database(dbPath);
  sqlite.exec(SCHEMA_DDL);
  sqlite.run(
    `INSERT INTO agents (name, project_dir, session_id, agent_file,
      purpose, state, created_at, last_task_at, total_tasks, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      FIXTURE_AGENT.name,
      FIXTURE_AGENT.projectDir,
      FIXTURE_AGENT.sessionId,
      `/tmp/${FIXTURE_AGENT.name}.md`,
      "Smoke fixture agent for Phase 1 E2E.",
      "idle",
      "2026-05-04 10:00:00",
      "2026-05-05 09:30:00",
      2,
      "sonnet",
    ],
  );

  const completedAt = "2026-05-05 09:31:00";
  sqlite.run(
    `INSERT INTO tasks
       (session_id, prompt, status, result_summary, cost_usd, duration_ms,
        num_turns, exit_code, channel, created_at, started_at, completed_at,
        model, task_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      FIXTURE_AGENT.sessionId,
      FIXTURE_AGENT.task.prompt,
      "done",
      `## Outcome\n\n${FIXTURE_AGENT.task.resultPhrase}: tightened the\n` +
        `flaky test by stubbing the clock.\n`,
      0.1234,
      4321,
      6,
      0,
      "cli",
      "2026-05-05 09:30:00",
      "2026-05-05 09:30:05",
      completedAt,
      "claude-sonnet-4-6",
      "standard",
    ],
  );
  sqlite.run(
    `INSERT INTO tasks
       (session_id, prompt, status, channel, created_at, model, task_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      FIXTURE_AGENT.sessionId,
      "Profile the cold-start path",
      "running",
      "cli",
      "2026-05-05 10:00:00",
      "claude-sonnet-4-6",
      "standard",
    ],
  );

  // Phase 3 — pre-seeded schedule + loop fixtures. The schedules-flow
  // spec lists/pauses/deletes this row; the loop-flow spec navigates
  // into the running loop's detail page to cancel it, and into the
  // pending-approval loop to exercise the approve gate.
  sqlite.run(
    `INSERT INTO schedules
       (name, agent_name, prompt, interval_minutes, enabled, run_count,
        consecutive_errors, channel, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 0, 0, 'cli', ?, ?)`,
    [
      FIXTURE_SCHEDULE.name,
      FIXTURE_AGENT.name,
      FIXTURE_SCHEDULE.prompt,
      60,
      "2026-05-04 11:00:00",
      "2026-05-04 11:00:00",
    ],
  );

  sqlite.run(
    `INSERT INTO loops
       (loop_id, agent, project, goal, done_when, loop_type, status,
        max_iterations, max_consecutive_failures, current_iteration,
        consecutive_failures, total_cost_usd, pending_approval,
        started_at, plan_enabled, pass_threshold, consecutive_passes)
     VALUES (?, ?, ?, ?, 'manual:', 'bridge', 'running', 10, 3, 1, 0,
             0.05, 0, ?, 0, 1, 0)`,
    [
      FIXTURE_LOOP_RUNNING.loopId,
      FIXTURE_AGENT.name,
      FIXTURE_AGENT.projectDir,
      FIXTURE_LOOP_RUNNING.goal,
      "2026-05-05 09:00:00",
    ],
  );

  sqlite.run(
    `INSERT INTO loops
       (loop_id, agent, project, goal, done_when, loop_type, status,
        max_iterations, max_consecutive_failures, current_iteration,
        consecutive_failures, total_cost_usd, pending_approval,
        started_at, plan_enabled, pass_threshold, consecutive_passes)
     VALUES (?, ?, ?, ?, 'manual:', 'bridge', 'running', 5, 3, 2, 0,
             0.20, 1, ?, 0, 1, 1)`,
    [
      FIXTURE_LOOP_PENDING_APPROVAL.loopId,
      FIXTURE_AGENT.name,
      FIXTURE_AGENT.projectDir,
      FIXTURE_LOOP_PENDING_APPROVAL.goal,
      "2026-05-05 09:30:00",
    ],
  );

  sqlite.close();

  // Seed transcript JSONL so /tasks/[id] can render its Transcript card
  // without falling through to the "no transcript on disk" banner. The
  // banner would still pass the spec, but the result-card assertion is
  // crisper with a populated transcript.
  const slug = projectSlug(FIXTURE_AGENT.projectDir);
  const sessionDir = join(claudeHome, "projects", slug);
  mkdirSync(sessionDir, { recursive: true });
  const jsonl = [
    JSON.stringify({
      type: "user",
      uuid: "u-1",
      timestamp: "2026-05-05T09:30:00Z",
      message: { content: FIXTURE_AGENT.task.prompt },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a-1",
      timestamp: "2026-05-05T09:30:30Z",
      message: {
        model: "claude-sonnet-4-6",
        content: [
          { type: "text", text: FIXTURE_AGENT.task.resultPhrase },
        ],
      },
    }),
  ].join("\n");
  writeFileSync(
    join(sessionDir, `${FIXTURE_AGENT.sessionId}.jsonl`),
    `${jsonl}\n`,
  );

  // `playwright.config.ts` already snapshotted the fixture paths into
  // `webServer.env` (FIXTURE_DB / FIXTURE_CLAUDE_HOME are deterministic
  // — see ./fixture.ts), so by the time the dev server starts the env
  // is already correct. We deliberately do *not* mutate
  // `process.env.BRIDGE_DB` here — that would have no effect on the
  // child process and could mislead a debugging dev.
  void dbPath;
  void claudeHome;
  void FIXTURE_PASSWORD;
  void FIXTURE_JWT_SECRET;
}
