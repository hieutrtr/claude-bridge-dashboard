// P3-T5 — `/schedules` page server component test. Mirrors
// `loops-page.test.ts`: spin up an isolated SQLite db with the daemon
// schema, seed `schedules` rows, render the page, assert the markup.
//
// Read-only invariant: `/schedules` is a server-rendered list — no
// POST/PUT/PATCH/DELETE export, no `"use client"` boundary at the page
// level (T7 inline action menu adds a client island, but the page
// itself stays server-rendered).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import { resetDb } from "../../src/server/db";

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

interface SeedOpts {
  name: string;
  agentName?: string;
  prompt?: string;
  intervalMinutes?: number | null;
  cronExpr?: string | null;
  enabled?: boolean;
  runCount?: number;
  consecutiveErrors?: number;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastError?: string | null;
}

function seed(db: Database, opts: SeedOpts): void {
  db.prepare(
    `INSERT INTO schedules
       (name, agent_name, prompt, interval_minutes, cron_expr,
        enabled, run_count, consecutive_errors,
        last_run_at, next_run_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.name,
    opts.agentName ?? "alpha",
    opts.prompt ?? "run the test suite",
    opts.intervalMinutes === undefined ? null : opts.intervalMinutes,
    opts.cronExpr === undefined ? null : opts.cronExpr,
    opts.enabled === undefined ? 1 : opts.enabled ? 1 : 0,
    opts.runCount ?? 0,
    opts.consecutiveErrors ?? 0,
    opts.lastRunAt ?? null,
    opts.nextRunAt ?? null,
    opts.lastError ?? null,
  );
}

let tmpDir: string;
let dbPath: string;
let db: Database;
const ORIGINAL_BRIDGE_DB = process.env.BRIDGE_DB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "schedules-page-test-"));
  dbPath = join(tmpDir, "bridge.db");
  const setup = new Database(dbPath);
  setup.exec(SCHEMA_DDL);
  setup.close();
  process.env.BRIDGE_DB = dbPath;
  resetDb();
  db = new Database(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_BRIDGE_DB === undefined) {
    delete process.env.BRIDGE_DB;
  } else {
    process.env.BRIDGE_DB = ORIGINAL_BRIDGE_DB;
  }
  resetDb();
});

describe("/schedules page — module surface", () => {
  it("exports a default async function", async () => {
    const mod = await import("../../app/schedules/page");
    expect(typeof mod.default).toBe("function");
  });

  it("does NOT export POST/PUT/PATCH/DELETE (read-only invariant)", async () => {
    const mod = await import("../../app/schedules/page");
    expect((mod as Record<string, unknown>).POST).toBeUndefined();
    expect((mod as Record<string, unknown>).PUT).toBeUndefined();
    expect((mod as Record<string, unknown>).PATCH).toBeUndefined();
    expect((mod as Record<string, unknown>).DELETE).toBeUndefined();
  });
});

describe("/schedules page — empty state", () => {
  it("renders empty-state copy when no schedules exist (no filters)", async () => {
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Schedules");
    expect(html).toContain("No recurring schedules yet");
    expect(html).toContain("bridge_schedule_add");
  });

  it("renders filtered empty-state when filters yield zero rows", async () => {
    seed(db, { name: "alpha-1", agentName: "alpha" });
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({
      searchParams: Promise.resolve({ agent: "ghost" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("No schedules match the current filters");
  });
});

describe("/schedules page — populated table", () => {
  it("renders cron expressions in plain English (cronstrue)", async () => {
    seed(db, {
      name: "daily-9am",
      cronExpr: "0 9 * * *",
      intervalMinutes: null,
      nextRunAt: "2026-05-07T09:00:00.000Z",
    });
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("daily-9am");
    expect(html).toContain("At 09:00 AM");
    // The raw cron expression appears only as a tooltip (title attr)
    // — never as visible text in the cadence column.
    expect(html).toContain('title="0 9 * * *"');
  });

  it("renders interval-mode rows as 'Every N minutes' / hours / days", async () => {
    seed(db, {
      name: "every-30",
      intervalMinutes: 30,
      cronExpr: null,
      nextRunAt: "2026-05-06T08:30:00.000Z",
    });
    seed(db, {
      name: "every-hour",
      intervalMinutes: 60,
      cronExpr: null,
      nextRunAt: "2026-05-06T09:00:00.000Z",
    });
    seed(db, {
      name: "every-day",
      intervalMinutes: 1440,
      cronExpr: null,
      nextRunAt: "2026-05-07T00:00:00.000Z",
    });
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Every 30 minutes");
    expect(html).toContain("Every hour");
    expect(html).toContain("Every day");
  });

  it("renders 'Paused' status for disabled schedules", async () => {
    seed(db, { name: "paused-job", enabled: false });
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Paused");
  });

  it("renders 'Failing' status when consecutiveErrors > 0 + lastError populated", async () => {
    seed(db, {
      name: "broken-job",
      enabled: true,
      consecutiveErrors: 3,
      lastError: "agent crashed",
    });
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Failing");
  });

  it("renders 'Active' status for healthy enabled schedules", async () => {
    seed(db, { name: "healthy-job", enabled: true });
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Active");
  });

  it("renders run count", async () => {
    seed(db, { name: "frequent", runCount: 42 });
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("42");
  });

  it("truncates very long prompts to a preview", async () => {
    const longPrompt = "x".repeat(200);
    seed(db, { name: "long", prompt: longPrompt });
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    // Truncation marker (one-character ellipsis) appears in the
    // rendered HTML.
    expect(html).toContain("…");
    // The full prompt is preserved in the tooltip title attribute.
    expect(html).toContain(longPrompt);
  });
});

describe("/schedules page — agent filter URL → query", () => {
  beforeEach(() => {
    seed(db, { name: "alpha-1", agentName: "alpha" });
    seed(db, { name: "beta-1", agentName: "beta" });
  });

  it("?agent=alpha narrows to that agent only", async () => {
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({
      searchParams: Promise.resolve({ agent: "alpha" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("alpha-1");
    expect(html).not.toContain("beta-1");
  });

  it("filter strip default value reflects URL", async () => {
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({
      searchParams: Promise.resolve({ agent: "alpha" }),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toMatch(/name="agent"[^>]*value="alpha"/);
  });
});

describe("/schedules page — ordering", () => {
  it("rows with earlier nextRunAt come first; null nextRunAt drops to bottom", async () => {
    seed(db, { name: "no-next", nextRunAt: null });
    seed(db, {
      name: "later",
      cronExpr: "0 0 * * *",
      nextRunAt: "2026-05-08T00:00:00.000Z",
    });
    seed(db, {
      name: "soonest",
      cronExpr: "0 0 * * *",
      nextRunAt: "2026-05-06T08:00:00.000Z",
    });
    const mod = await import("../../app/schedules/page");
    const tree = await mod.default({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree);
    const soonestIdx = html.indexOf("soonest");
    const laterIdx = html.indexOf("later");
    const noNextIdx = html.indexOf("no-next");
    expect(soonestIdx).toBeGreaterThan(-1);
    expect(laterIdx).toBeGreaterThan(soonestIdx);
    expect(noNextIdx).toBeGreaterThan(laterIdx);
  });
});
