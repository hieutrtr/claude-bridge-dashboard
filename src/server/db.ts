// T5 — Drizzle DB handle for the dashboard package.
//
// Opens `bridge.db` via bun:sqlite (the runtime SQLite that ships with Bun
// and shares its file lock with the daemon — see ARCHITECTURE.md §2 row
// "Runtime"). PRAGMAs match what T4 proved safe under concurrent writes:
// `journal_mode=WAL` + `busy_timeout=5000`.
//
// Lazily initialized so tests can override `BRIDGE_DB` then call resetDb()
// before importing the router.

import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import * as schema from "../db/schema";

export type Db = BunSQLiteDatabase<typeof schema>;

let cached: Db | null = null;

export function dbPath(): string {
  return process.env.BRIDGE_DB ?? join(homedir(), ".claude-bridge", "bridge.db");
}

function open(path: string): Db {
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode=WAL;");
  sqlite.exec("PRAGMA busy_timeout=5000;");
  return drizzle(sqlite, { schema });
}

export function getDb(): Db {
  if (cached) return cached;
  cached = open(dbPath());
  return cached;
}

// Test-only: clear the cached handle so the next getDb() picks up a new
// BRIDGE_DB env override.
export function resetDb(): void {
  cached = null;
}
