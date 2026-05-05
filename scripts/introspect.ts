#!/usr/bin/env bun
// T3 — drizzle-kit introspect runner.
//
// Copies the live bridge.db (and its WAL/SHM sidecars) to a temp file so the
// running daemon is never blocked, runs `drizzle-kit introspect`, then deletes
// the temp DB. The generated schema lands at src/db/schema.ts.
//
// Usage: bun run scripts/introspect.ts
//   BRIDGE_DB=/path/to/bridge.db   override source DB
//
// See docs/web-dashboard/tasks/phase-0/T03-drizzle-introspect.md for context.

import { existsSync, copyFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const sourceDb = process.env.BRIDGE_DB ?? join(homedir(), ".claude-bridge", "bridge.db");
const tmpDb = join(import.meta.dir, "..", ".tmp-introspect.db");

if (!existsSync(sourceDb)) {
  console.error(`introspect: source DB not found at ${sourceDb}`);
  console.error("Set BRIDGE_DB=/path/to/bridge.db or run `bridge install` first.");
  process.exit(1);
}

mkdirSync(dirname(tmpDb), { recursive: true });

console.log(`introspect: copying ${sourceDb} → ${tmpDb}`);
copyFileSync(sourceDb, tmpDb);
for (const ext of ["-wal", "-shm"]) {
  const src = sourceDb + ext;
  if (existsSync(src)) copyFileSync(src, tmpDb + ext);
}

console.log("introspect: running drizzle-kit introspect (sqlite)");
const result = spawnSync(
  "bun",
  ["x", "drizzle-kit", "introspect"],
  {
    cwd: join(import.meta.dir, ".."),
    stdio: "inherit",
    env: { ...process.env, BRIDGE_DB_INTROSPECT: tmpDb },
  },
);

// Always clean up the temp DB + sidecars regardless of drizzle-kit exit code.
for (const ext of ["", "-wal", "-shm"]) {
  try { unlinkSync(tmpDb + ext); } catch {}
}

if (result.status !== 0) {
  console.error(`introspect: drizzle-kit exited with code ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log("introspect: done. Review src/db/schema.ts for boolean coercion patches.");
