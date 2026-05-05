// T04 — migration runner for dashboard-owned tables. Reads `*.sql`
// files from `src/db/migrations/` in lexicographic order and applies
// each one inside `BEGIN IMMEDIATE … COMMIT`. Every statement we ship
// is `IF NOT EXISTS`-guarded, so the runner is idempotent and safe
// under concurrent dashboard processes (one wins the immediate
// transaction; the other waits — `busy_timeout=5000` is set in
// `db.ts` — and observes that the table already exists).
//
// The legacy `0000_violet_random.sql` is the drizzle-kit introspection
// artifact: its body is wrapped entirely in `/* */` and was never
// intended to run on a live DB. We skip it explicitly so the runner's
// behaviour is documented rather than relying on the comment block.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STATEMENT_DELIM = "--> statement-breakpoint";

function migrationsDir(): string {
  // Resolve relative to this file so the runner works regardless of
  // process.cwd(). Next dev / Next build / bun test all hit this path.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "db", "migrations");
}

function isDrizzleIntrospectionArtifact(sql: string): boolean {
  // The introspect file wraps its entire body in `/* … */`. Anything
  // after the opening `/*` and before the closing `*/` is non-SQL.
  // We detect this by trimming lines and checking for the comment
  // wrappers that drizzle-kit emits at the top of the artifact.
  const trimmed = sql.trim();
  return (
    trimmed.includes("If you want to run this migration please uncomment this code") ||
    /^\/\*[\s\S]*\*\/\s*$/.test(trimmed)
  );
}

function isCommentOnly(s: string): boolean {
  // A chunk that contains only `--` line comments and whitespace has no
  // SQL to execute. Anything else (including a CREATE TABLE preceded by
  // `--` header comments) is forwarded to the engine — SQLite parses
  // comments inside the same `exec` call without issue.
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    if (t.startsWith("--")) continue;
    return false;
  }
  return true;
}

function statementsFromFile(sql: string): string[] {
  return sql
    .split(STATEMENT_DELIM)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isCommentOnly(s));
}

export interface RunMigrationsOptions {
  /** Override the migrations directory — used by tests. */
  dir?: string;
}

export function runMigrations(
  db: Database,
  opts: RunMigrationsOptions = {},
): void {
  const dir = opts.dir ?? migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf-8");
    if (isDrizzleIntrospectionArtifact(sql)) continue;
    const statements = statementsFromFile(sql);
    if (statements.length === 0) continue;

    db.exec("BEGIN IMMEDIATE;");
    try {
      for (const stmt of statements) {
        db.exec(stmt);
      }
      db.exec("COMMIT;");
    } catch (err) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ignore rollback failures
      }
      throw err;
    }
  }
}
