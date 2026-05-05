# @claude-bridge/dashboard

Web dashboard for [claude-bridge](https://github.com/hieutrtr/claude-bridge) — observe
agents, tasks, loops, and schedules from a browser.

This dashboard is **shipped as a standalone repo**, decoupled from the
`claude-bridge` daemon. Each tagged release (`v0.1.0`, `v0.2.0`, ...) is installable
independently. The daemon discovers and boots the dashboard on demand via an MCP tool
(`bridge_dashboard_install`) and registers it as an agent named `dashboard`.

See `docs/web-dashboard/v2/` in the `claude-bridge` repo for the full architecture.

## Status

Phase 0 (foundation) and Phase 0.5 (migration to standalone repo) — in progress. UI
features land in Phases 1–4 (see `IMPLEMENTATION-PLAN.md` in the daemon repo).

## Install

Requires Bun ≥ 1.1.

```bash
git clone https://github.com/hieutrtr/claude-bridge-dashboard
cd claude-bridge-dashboard
bun install
```

The dashboard expects a running `claude-bridge` daemon on the same machine. It reads
`~/.claude-bridge/config.json` to discover the daemon's SQLite database and socket
endpoint.

## Run

```bash
bun run dev          # development (hot reload, default :3000)
bun run build        # production build
bun run start        # production server
```

## Connect to the daemon

The dashboard auto-discovers a local `claude-bridge` daemon by reading
`~/.claude-bridge/config.json`. Expected schema (subject to change in Phase 1):

```json
{
  "version": 1,
  "daemon": {
    "db_path": "~/.claude-bridge/bridge.db",
    "socket": "~/.claude-bridge/bridge.sock"
  },
  "dashboards": [
    { "version": "v0.1.0", "path": "~/.claude-bridge/dashboards/v0.1.0", "default": true }
  ]
}
```

If `~/.claude-bridge/config.json` is absent the dashboard falls back to the default
paths above and prints a warning. See `src/lib/discovery.ts` for the loader (added in
Phase 0.5).

## Recommended install via the daemon

In Phase 5, prefer installing the dashboard through the daemon's MCP tool — it handles
git clone, version selection, dependency install, and agent registration:

```
bridge_dashboard_install({ version: "v0.1.0" })
bridge_dispatch dashboard "start"
```

Until Phase 5 lands, install manually using the steps above.

## Repository layout

```
app/                Next.js app router routes
src/
  components/       UI primitives + composed views
  db/               Drizzle ORM schema (read-only against bridge.db)
  lib/              Discovery, config loading, helpers
  server/           tRPC routers (Server Components / API)
scripts/
  introspect.ts     Generate Drizzle schema from a sample bridge.db
drizzle.config.ts   Drizzle config
next.config.ts      Next.js config
package.json        Standalone — not a Bun workspace member
```

## License

MIT.
