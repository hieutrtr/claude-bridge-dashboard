// T10 — page-level read-only smoke test for `/agents/[name]?tab=memory`.
// Mirrors `tests/app/cost-page.test.ts` from T09: assert that the page
// module loads, that no mutation handler is exported, and (under a
// seeded fixture) that the rendered HTML surfaces both the markdown
// body and the sibling-file list. We cannot fully exercise the React
// tree without jsdom, but `renderToStaticMarkup` walks the synchronous
// markup — sufficient for a Phase 1 smoke check. Playwright in T13
// will drive the full flow including tab switching.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import { resetDb } from "../../src/server/db";

let tmpDir: string;
let dbPath: string;
const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;
const ORIGINAL_CLAUDE_HOME = process.env.CLAUDE_HOME;

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
    cost_usd REAL,
    duration_ms INTEGER,
    created_at NUMERIC DEFAULT CURRENT_TIMESTAMP,
    completed_at NUMERIC,
    channel TEXT DEFAULT 'cli'
  );
`;

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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-memory-page-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(SCHEMA_DDL);
  sqlite.close();
  process.env.BRIDGE_DB = dbPath;
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

describe("/agents/[name] page (Memory tab)", () => {
  it("module exports a default async function", async () => {
    const mod = await import("../../app/agents/[name]/page");
    expect(typeof mod.default).toBe("function");
  });

  it("does NOT export POST/PUT/PATCH/DELETE handlers (read-only invariant)", async () => {
    const mod = await import("../../app/agents/[name]/page");
    expect((mod as Record<string, unknown>).POST).toBeUndefined();
    expect((mod as Record<string, unknown>).PUT).toBeUndefined();
    expect((mod as Record<string, unknown>).PATCH).toBeUndefined();
    expect((mod as Record<string, unknown>).DELETE).toBeUndefined();
  });

  it("renders the empty-state copy when the memory directory is missing", async () => {
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      INSERT INTO agents (name, project_dir, session_id, agent_file)
      VALUES ('alpha', '/tmp/alpha-empty', 's-alpha', '/tmp/alpha.md');
    `);
    sqlite.close();

    const mod = await import("../../app/agents/[name]/page");
    const tree = await mod.default({
      params: Promise.resolve({ name: "alpha" }),
      searchParams: Promise.resolve({ tab: "memory" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Memory");
    expect(html).toContain("No memory recorded");
  });

  it("renders the markdown body and sibling files when MEMORY.md is present", async () => {
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      INSERT INTO agents (name, project_dir, session_id, agent_file)
      VALUES ('alpha', '/tmp/alpha-mem', 's-alpha-mem', '/tmp/alpha.md');
    `);
    sqlite.close();
    writeMemoryFixture(tmpDir, "/tmp/alpha-mem", [
      { name: "MEMORY.md", content: "# Project Memory\n\nVision: ship dashboard.\n" },
      { name: "user_role.md", content: "user is a senior engineer" },
    ]);

    const mod = await import("../../app/agents/[name]/page");
    const tree = await mod.default({
      params: Promise.resolve({ name: "alpha" }),
      searchParams: Promise.resolve({ tab: "memory" }),
    });
    const html = renderToStaticMarkup(tree);
    // Markdown body
    expect(html).toContain("Project Memory");
    expect(html).toContain("Vision: ship dashboard");
    // Sibling-file list (filenames echoed verbatim)
    expect(html).toContain("user_role.md");
    expect(html).toContain("MEMORY.md");
    // Empty-state copy MUST NOT show alongside real content.
    expect(html).not.toContain("No memory recorded");
  });

  it("renders the file-too-large banner with the actual byte size", async () => {
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      INSERT INTO agents (name, project_dir, session_id, agent_file)
      VALUES ('alpha', '/tmp/alpha-big', 's-alpha-big', '/tmp/alpha.md');
    `);
    sqlite.close();
    writeMemoryFixture(tmpDir, "/tmp/alpha-big", [
      { name: "MEMORY.md", content: "x".repeat(500_001) },
    ]);

    const mod = await import("../../app/agents/[name]/page");
    const tree = await mod.default({
      params: Promise.resolve({ name: "alpha" }),
      searchParams: Promise.resolve({ tab: "memory" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("too large");
    // The actual byte count should appear (digits, comma-grouped or raw).
    expect(html).toMatch(/500[, ]?001/);
  });
});
