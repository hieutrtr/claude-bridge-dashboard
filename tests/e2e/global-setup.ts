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
  FIXTURE_PASSWORD,
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
