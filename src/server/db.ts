// T5 — Drizzle DB handle for the dashboard package.
//
// Opens `bridge.db` via bun:sqlite (the runtime SQLite that ships with Bun
// and shares its file lock with the daemon — see ARCHITECTURE.md §2 row
// "Runtime"). PRAGMAs match what T4 proved safe under concurrent writes:
// `journal_mode=WAL` + `busy_timeout=5000`.
//
// T04 — on first access, run the dashboard-owned migrations against the
// same handle the rest of the dashboard uses. Migrations are idempotent
// (`CREATE TABLE IF NOT EXISTS` + `BEGIN IMMEDIATE`) so concurrent
// dashboard processes are safe.
//
// Lazily initialized so tests can override `BRIDGE_DB` then call resetDb()
// before importing the router.

import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import * as schema from "../db/schema";
import { runMigrations } from "./migrate";

export type Db = BunSQLiteDatabase<typeof schema>;

let cachedDrizzle: Db | null = null;
let cachedSqlite: Database | null = null;

export function dbPath(): string {
  return process.env.BRIDGE_DB ?? join(homedir(), ".claude-bridge", "bridge.db");
}

function open(path: string): { drizzle: Db; sqlite: Database } {
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode=WAL;");
  sqlite.exec("PRAGMA busy_timeout=5000;");
  runMigrations(sqlite);
  return { drizzle: drizzle(sqlite, { schema }), sqlite };
}

function ensureCached(): { drizzle: Db; sqlite: Database } {
  if (cachedDrizzle && cachedSqlite) {
    return { drizzle: cachedDrizzle, sqlite: cachedSqlite };
  }
  const opened = open(dbPath());
  cachedDrizzle = opened.drizzle;
  cachedSqlite = opened.sqlite;
  return opened;
}

export function getDb(): Db {
  return ensureCached().drizzle;
}

export function getSqlite(): Database {
  return ensureCached().sqlite;
}

// Test-only: clear the cached handles so the next get*() picks up a new
// BRIDGE_DB env override and re-runs migrations on the new path.
export function resetDb(): void {
  if (cachedSqlite) {
    try {
      cachedSqlite.close();
    } catch {
      // already closed / in use — ignore
    }
  }
  cachedDrizzle = null;
  cachedSqlite = null;
}
