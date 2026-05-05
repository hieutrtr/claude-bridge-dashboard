import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appRouter } from "../../src/server/routers/_app";
import { resetDb } from "../../src/server/db";

let tmpDir: string;
let dbPath: string;
const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;
const ORIGINAL_CLAUDE_HOME = process.env.CLAUDE_HOME;

// Minimal DDL — only the columns the agents router projects. Mirrors
// `agents` from src/db/schema.ts. We deliberately don't recreate the full
// daemon schema; the router under test only touches `agents`.
const AGENTS_DDL = `
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
`;

function pick<T>(r: Record<string, unknown>, key: string, fallback: T): T {
  // Distinguish "not provided" (use fallback) from "explicitly null" (keep null).
  return (key in r ? (r[key] as T) : fallback);
}

function seed(db: Database, rows: Array<Record<string, unknown>>) {
  const stmt = db.prepare(`
    INSERT INTO agents
      (name, project_dir, session_id, agent_file, purpose,
       state, created_at, last_task_at, total_tasks, model)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(
      r.name as string,
      r.projectDir as string,
      pick<string>(r, "sessionId", `${r.name}-session`),
      pick<string>(r, "agentFile", `/tmp/${r.name}.md`),
      pick<string | null>(r, "purpose", null),
      pick<string | null>(r, "state", "idle"),
      pick<string>(r, "createdAt", "2026-05-05 10:00:00"),
      pick<string | null>(r, "lastTaskAt", null),
      pick<number | null>(r, "totalTasks", 0),
      pick<string | null>(r, "model", "sonnet"),
    );
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agents-router-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(AGENTS_DDL);
  sqlite.close();
  process.env.BRIDGE_DB = dbPath;
  // T10 — point CLAUDE_HOME at the same temp dir so tests can
  // materialise a memory fixture under <home>/projects/<slug>/memory/.
  // The agents.memory procedure picks this up via env.
  process.env.CLAUDE_HOME = tmpDir;
  resetDb();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_BRIDGE_DB === undefined) {
    delete process.env.BRIDGE_DB;
  } else {
    process.env.BRIDGE_DB = ORIGINAL_BRIDGE_DB;
  }
  if (ORIGINAL_CLAUDE_HOME === undefined) {
    delete process.env.CLAUDE_HOME;
  } else {
    process.env.CLAUDE_HOME = ORIGINAL_CLAUDE_HOME;
  }
  resetDb();
});

// T10 — write a memory fixture at
// <CLAUDE_HOME>/projects/<slug>/memory/<file>.
// `slug` is the project_dir flipped through `projectSlug`
// (every '/' → '-').
function writeMemoryFixture(
  home: string,
  projectDir: string,
  files: Array<{ name: string; content: string }>,
): string {
  const slug = projectDir.replace(/\//g, "-");
  const dir = join(home, "projects", slug, "memory");
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(dir, f.name), f.content);
  }
  return dir;
}

describe("agents.list (enriched)", () => {
  it("returns [] on an empty agents table", async () => {
    const caller = appRouter.createCaller({});
    const result = await caller.agents.list();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("returns one row per seeded agent", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [
      {
        name: "alpha",
        projectDir: "/tmp/alpha",
        state: "running",
        lastTaskAt: "2026-05-05 09:00:00",
        totalTasks: 12,
        model: "opus",
      },
      {
        name: "beta",
        projectDir: "/tmp/beta",
        state: "idle",
        lastTaskAt: null,
        totalTasks: 0,
        model: "sonnet",
      },
      {
        name: "gamma",
        projectDir: "/tmp/gamma",
        state: "errored",
        lastTaskAt: "2026-05-04 22:11:30",
        totalTasks: 3,
        model: null,
      },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.agents.list();
    expect(result.length).toBe(3);
    const names = result.map((a) => a.name).sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
  });

  it("projects only the six DTO fields (no sessionId/agentFile/purpose/createdAt)", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [{ name: "alpha", projectDir: "/tmp/alpha" }]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const [row] = await caller.agents.list();
    expect(row).toBeDefined();
    const keys = Object.keys(row!).sort();
    expect(keys).toEqual([
      "lastTaskAt",
      "model",
      "name",
      "projectDir",
      "state",
      "totalTasks",
    ]);
  });

  it("preserves field types (string / nullable / number)", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [
      {
        name: "alpha",
        projectDir: "/tmp/alpha",
        state: "running",
        lastTaskAt: "2026-05-05 09:00:00",
        totalTasks: 7,
        model: "opus",
      },
      {
        name: "beta",
        projectDir: "/tmp/beta",
        state: null,
        lastTaskAt: null,
        totalTasks: 0,
        model: null,
      },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.agents.list();
    const alpha = result.find((a) => a.name === "alpha")!;
    const beta = result.find((a) => a.name === "beta")!;

    expect(typeof alpha.name).toBe("string");
    expect(typeof alpha.projectDir).toBe("string");
    expect(alpha.state).toBe("running");
    expect(alpha.lastTaskAt).toBe("2026-05-05 09:00:00");
    expect(alpha.totalTasks).toBe(7);
    expect(alpha.model).toBe("opus");

    expect(beta.state).toBeNull();
    expect(beta.lastTaskAt).toBeNull();
    expect(beta.model).toBeNull();
    expect(beta.totalTasks).toBe(0);
  });

  it("handles 20 rows (data-layer side of the FCP acceptance)", async () => {
    const sqlite = new Database(dbPath);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      name: `agent-${i.toString().padStart(2, "0")}`,
      projectDir: `/tmp/agent-${i}`,
      state: i % 3 === 0 ? "running" : "idle",
      lastTaskAt: i % 2 === 0 ? "2026-05-05 09:00:00" : null,
      totalTasks: i,
      model: i % 2 === 0 ? "opus" : "sonnet",
    }));
    seed(sqlite, rows);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.agents.list();
    expect(result.length).toBe(20);
    for (const row of result) {
      expect(typeof row.name).toBe("string");
      expect(typeof row.projectDir).toBe("string");
      expect(typeof row.totalTasks).toBe("number");
    }
  });
});

describe("agents.get", () => {
  it("returns null on an empty agents table", async () => {
    const caller = appRouter.createCaller({});
    const result = await caller.agents.get({ name: "nonexistent" });
    expect(result).toBeNull();
  });

  it("returns null when no row matches the requested name", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [{ name: "alpha", projectDir: "/tmp/alpha" }]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.agents.get({ name: "beta" });
    expect(result).toBeNull();
  });

  it("returns the matching agent with the same six DTO fields as list", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [
      {
        name: "alpha",
        projectDir: "/tmp/alpha",
        state: "running",
        lastTaskAt: "2026-05-05 09:00:00",
        totalTasks: 12,
        model: "opus",
      },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.agents.get({ name: "alpha" });
    expect(result).not.toBeNull();
    const keys = Object.keys(result!).sort();
    expect(keys).toEqual([
      "lastTaskAt",
      "model",
      "name",
      "projectDir",
      "state",
      "totalTasks",
    ]);
    expect(result!.name).toBe("alpha");
    expect(result!.state).toBe("running");
    expect(result!.model).toBe("opus");
    expect(result!.totalTasks).toBe(12);
    expect(result!.lastTaskAt).toBe("2026-05-05 09:00:00");
    expect(result!.projectDir).toBe("/tmp/alpha");
  });

  it("tie-breaks on project_dir ascending when two rows share a name", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [
      {
        name: "shared",
        projectDir: "/tmp/zeta",
        sessionId: "shared-session-z",
        state: "running",
      },
      {
        name: "shared",
        projectDir: "/tmp/alpha",
        sessionId: "shared-session-a",
        state: "idle",
      },
    ]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.agents.get({ name: "shared" });
    expect(result).not.toBeNull();
    expect(result!.projectDir).toBe("/tmp/alpha");
    expect(result!.state).toBe("idle");
  });

  it("rejects an empty name input", async () => {
    const caller = appRouter.createCaller({});
    let threw = false;
    try {
      await caller.agents.get({ name: "" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// T10 — agents.memory({ name }) reads
// <CLAUDE_HOME>/projects/<slug>/memory/MEMORY.md plus sibling .md files.
// All tests below use the temp CLAUDE_HOME wired in beforeEach +
// `writeMemoryFixture` to materialise on-disk state.
describe("agents.memory", () => {
  it("returns null for an unknown agent name (no throw)", async () => {
    const caller = appRouter.createCaller({});
    const result = await caller.agents.memory({ name: "ghost" });
    expect(result).toBeNull();
  });

  it("returns dirMissing+fileMissing+empty files when the memory dir is absent", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [{ name: "alpha", projectDir: "/tmp/alpha-no-mem" }]);
    sqlite.close();

    const caller = appRouter.createCaller({});
    const result = await caller.agents.memory({ name: "alpha" });
    expect(result).not.toBeNull();
    expect(result!.dirMissing).toBe(true);
    expect(result!.fileMissing).toBe(true);
    expect(result!.fileTooLarge).toBe(false);
    expect(result!.memoryMd).toBeNull();
    expect(result!.memoryMdTruncated).toBe(false);
    expect(result!.fileBytes).toBe(0);
    expect(result!.files).toEqual([]);
    expect(result!.projectDir).toBe("/tmp/alpha-no-mem");
    expect(typeof result!.dirPath).toBe("string");
    expect(result!.dirPath.endsWith("/memory")).toBe(true);
  });

  it("returns fileMissing+sibling .md when MEMORY.md is absent but the dir exists", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [{ name: "alpha", projectDir: "/tmp/alpha-sib" }]);
    sqlite.close();
    writeMemoryFixture(tmpDir, "/tmp/alpha-sib", [
      { name: "user_role.md", content: "# user role\nuser is a dev" },
      { name: "feedback_tests.md", content: "# tests\nno mocks" },
    ]);

    const caller = appRouter.createCaller({});
    const result = await caller.agents.memory({ name: "alpha" });
    expect(result).not.toBeNull();
    expect(result!.dirMissing).toBe(false);
    expect(result!.fileMissing).toBe(true);
    expect(result!.memoryMd).toBeNull();
    expect(result!.fileBytes).toBe(0);
    expect(result!.files).toEqual(["feedback_tests.md", "user_role.md"]);
  });

  it("returns memoryMd content + files list when MEMORY.md is present", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [{ name: "alpha", projectDir: "/tmp/alpha-ok" }]);
    sqlite.close();
    const body = "# Project Memory\n\n- Vision: ship\n- MVP goal: dashboard\n";
    writeMemoryFixture(tmpDir, "/tmp/alpha-ok", [
      { name: "MEMORY.md", content: body },
      { name: "user_role.md", content: "user role notes" },
    ]);

    const caller = appRouter.createCaller({});
    const result = await caller.agents.memory({ name: "alpha" });
    expect(result).not.toBeNull();
    expect(result!.dirMissing).toBe(false);
    expect(result!.fileMissing).toBe(false);
    expect(result!.fileTooLarge).toBe(false);
    expect(result!.memoryMd).toBe(body);
    expect(result!.memoryMdTruncated).toBe(false);
    expect(result!.fileBytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(result!.files).toEqual(["MEMORY.md", "user_role.md"]);
  });

  it("flags fileTooLarge when MEMORY.md exceeds the 500_000 byte cap", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [{ name: "alpha", projectDir: "/tmp/alpha-big" }]);
    sqlite.close();
    const giant = "a".repeat(500_001);
    writeMemoryFixture(tmpDir, "/tmp/alpha-big", [
      { name: "MEMORY.md", content: giant },
    ]);

    const caller = appRouter.createCaller({});
    const result = await caller.agents.memory({ name: "alpha" });
    expect(result).not.toBeNull();
    expect(result!.fileTooLarge).toBe(true);
    expect(result!.memoryMd).toBeNull();
    expect(result!.fileBytes).toBe(500_001);
    expect(result!.files).toEqual(["MEMORY.md"]);
  });

  it("filters out non-md entries (sub-dirs, dotfiles, .txt) from files", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [{ name: "alpha", projectDir: "/tmp/alpha-mix" }]);
    sqlite.close();
    const dir = writeMemoryFixture(tmpDir, "/tmp/alpha-mix", [
      { name: "MEMORY.md", content: "# top" },
      { name: "notes.md", content: "ok" },
      { name: "scratch.txt", content: "not md" },
      { name: ".DS_Store", content: "" },
    ]);
    // Add a sub-directory inside memory/ — must be filtered.
    mkdirSync(join(dir, "subdir"), { recursive: true });
    writeFileSync(join(dir, "subdir", "deep.md"), "should be ignored");

    const caller = appRouter.createCaller({});
    const result = await caller.agents.memory({ name: "alpha" });
    expect(result).not.toBeNull();
    expect(result!.files).toEqual(["MEMORY.md", "notes.md"]);
  });

  it("sorts files ascending", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [{ name: "alpha", projectDir: "/tmp/alpha-sort" }]);
    sqlite.close();
    writeMemoryFixture(tmpDir, "/tmp/alpha-sort", [
      { name: "z_last.md", content: "z" },
      { name: "MEMORY.md", content: "m" },
      { name: "a_first.md", content: "a" },
    ]);

    const caller = appRouter.createCaller({});
    const result = await caller.agents.memory({ name: "alpha" });
    expect(result).not.toBeNull();
    expect(result!.files).toEqual(["MEMORY.md", "a_first.md", "z_last.md"]);
  });

  it("caps files at 200 entries", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [{ name: "alpha", projectDir: "/tmp/alpha-cap" }]);
    sqlite.close();
    const fixture: Array<{ name: string; content: string }> = [];
    for (let i = 0; i < 250; i++) {
      fixture.push({
        name: `note_${i.toString().padStart(3, "0")}.md`,
        content: "x",
      });
    }
    writeMemoryFixture(tmpDir, "/tmp/alpha-cap", fixture);

    const caller = appRouter.createCaller({});
    const result = await caller.agents.memory({ name: "alpha" });
    expect(result).not.toBeNull();
    expect(result!.files.length).toBe(200);
    // Sorted ascending, so the kept slice is note_000..note_199.
    expect(result!.files[0]).toBe("note_000.md");
    expect(result!.files[199]).toBe("note_199.md");
  });

  it("tie-breaks cross-project name collision on project_dir ASC (matches agents.get)", async () => {
    const sqlite = new Database(dbPath);
    seed(sqlite, [
      {
        name: "shared",
        projectDir: "/tmp/zeta-mem",
        sessionId: "shared-mem-z",
      },
      {
        name: "shared",
        projectDir: "/tmp/alpha-mem",
        sessionId: "shared-mem-a",
      },
    ]);
    sqlite.close();
    // Only seed memory under the alphabetically-first project_dir; the
    // procedure should resolve to that one.
    writeMemoryFixture(tmpDir, "/tmp/alpha-mem", [
      { name: "MEMORY.md", content: "alpha-mem wins" },
    ]);

    const caller = appRouter.createCaller({});
    const result = await caller.agents.memory({ name: "shared" });
    expect(result).not.toBeNull();
    expect(result!.projectDir).toBe("/tmp/alpha-mem");
    expect(result!.memoryMd).toBe("alpha-mem wins");
  });

  it("rejects an empty name input via Zod", async () => {
    const caller = appRouter.createCaller({});
    let threw = false;
    try {
      await caller.agents.memory({ name: "" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("is registered as a query procedure (read-only invariant)", () => {
    // tRPC v11 flattens procedures into a `<router>.<proc>`-keyed map on
    // `appRouter._def.procedures`. Each entry's `_def.type` is one of
    // `"query"` / `"mutation"` / `"subscription"`. Phase 1 is read-only,
    // so this MUST be `"query"`.
    const procs = appRouter._def.procedures as unknown as Record<
      string,
      { _def: { type: string } }
    >;
    expect(procs["agents.memory"]).toBeDefined();
    expect(procs["agents.memory"]!._def.type).toBe("query");
  });
});
