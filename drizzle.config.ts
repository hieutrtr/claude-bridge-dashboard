import { defineConfig } from "drizzle-kit";

// Introspection target: a temp **copy** of the live bridge.db that
// `scripts/introspect.ts` prepares before invoking drizzle-kit. We never
// point drizzle-kit at the live ~/.claude-bridge/bridge.db directly, so the
// daemon's WAL writes are never disrupted (per ARCHITECTURE.md §1.3 +
// IMPLEMENTATION-PLAN.md Phase 0 §Risk #1).
//
// Output lands in apps/web/src/db/ — that's where the future tRPC layer
// (P0-T5 onward) will import the schema from.
// drizzle-kit picks @libsql/client when dbCredentials.url begins with `file:`.
// We can't use better-sqlite3 here — its native bindings don't load under Bun
// (https://github.com/oven-sh/bun/issues/4290). libsql is pure-JS and works.
const tmpDb = process.env.BRIDGE_DB_INTROSPECT ?? "./.tmp-introspect.db";

export default defineConfig({
  // SQLite dialect over the libsql client (the schema we generate is plain
  // SQLite — `dialect: "turso"` is the drizzle-kit name for "sqlite via
  // @libsql/client", same SQL, different transport).
  dialect: "turso",
  schema: "./src/db/schema.ts",
  out: "./src/db",
  dbCredentials: {
    url: `file:${tmpDb}`,
  },
});
