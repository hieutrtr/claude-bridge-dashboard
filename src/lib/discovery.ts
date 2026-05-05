import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export class BridgeNotInstalledError extends Error {
  readonly home: string;
  readonly configPath: string;

  constructor(home: string) {
    const configPath = join(home, "config.json");
    super(
      `claude-bridge config not found at ${configPath} (CLAUDE_BRIDGE_HOME=${home}). ` +
        `Run \`bridge install\` on the host machine first, then start the dashboard.`,
    );
    this.name = "BridgeNotInstalledError";
    this.home = home;
    this.configPath = configPath;
  }
}

export interface DashboardInstall {
  version: string;
  path: string;
  default: boolean;
}

export interface BridgeContext {
  /** Resolved $CLAUDE_BRIDGE_HOME used to read config. */
  home: string;
  /** Daemon SQLite database path (absolute). */
  dbPath: string;
  /** Daemon Unix socket for permission relay / RPC. */
  socket: string;
  /** MCP endpoint hint — currently always "stdio". */
  mcpEndpoint: string;
  /** Append-only event log path the dashboard tails for SSE. */
  eventsLog: string;
  /** Directory where per-agent .md files live. */
  agentsDir: string;
  /** Daemon version (semver, no leading v). */
  version: string;
  /** Daemon's declared compat range for dashboard versions. */
  compat: string;
  /** Default dashboard install row, or null if none registered yet. */
  dashboard: DashboardInstall | null;
}

interface RawDaemon {
  version: string;
  db_path: string;
  socket: string;
  mcp_endpoint: string;
  events_log: string;
  compat_range_for_dashboard: string;
}

interface RawDashboard {
  version: string;
  path: string;
  default: boolean;
}

interface RawConfig {
  version: number;
  daemon: RawDaemon;
  agents_dir: string;
  dashboards?: RawDashboard[];
}

export interface DiscoverOptions {
  home?: string;
}

export function discoverBridgeDaemon(
  opts: DiscoverOptions = {},
): BridgeContext {
  const home =
    opts.home ??
    process.env.CLAUDE_BRIDGE_HOME ??
    join(homedir(), ".claude-bridge");
  const configPath = join(home, "config.json");

  if (!existsSync(configPath)) {
    throw new BridgeNotInstalledError(home);
  }

  const raw = readFileSync(configPath, "utf-8");
  const cfg = JSON.parse(raw) as RawConfig;

  const installs = cfg.dashboards ?? [];
  const defaultDash =
    installs.find((d) => d.default === true) ?? installs[0] ?? null;

  return {
    home,
    dbPath: cfg.daemon.db_path,
    socket: cfg.daemon.socket,
    mcpEndpoint: cfg.daemon.mcp_endpoint,
    eventsLog: cfg.daemon.events_log,
    agentsDir: cfg.agents_dir,
    version: cfg.daemon.version,
    compat: cfg.daemon.compat_range_for_dashboard,
    dashboard: defaultDash
      ? {
          version: defaultDash.version,
          path: defaultDash.path,
          default: defaultDash.default,
        }
      : null,
  };
}
