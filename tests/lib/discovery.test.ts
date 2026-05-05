import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverBridgeDaemon,
  BridgeNotInstalledError,
} from "../../src/lib/discovery";

let tmpHome: string;

const validConfig = {
  version: 1,
  daemon: {
    version: "0.6.2",
    db_path: "/abs/.claude-bridge/bridge.db",
    socket: "/abs/.claude-bridge/daemon.sock",
    mcp_endpoint: "stdio",
    events_log: "/abs/.claude-bridge/events.log",
    compat_range_for_dashboard: ">=0.1.0 <1.0.0",
  },
  agents_dir: "/abs/.claude-bridge/agents",
  dashboards: [
    {
      version: "0.1.0",
      path: "/abs/.claude-bridge/dashboards/v0.1.0",
      default: true,
      installed_at: "2026-05-05T10:23:11Z",
      installed_from: "github.com/org/claude-bridge-dashboard@v0.1.0",
    },
  ],
  channels: {
    telegram: { enabled: true, bot_dir: "/abs/projects/bridge-bot" },
    slack: { enabled: false },
    discord: { enabled: false },
  },
};

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `cbd-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("discoverBridgeDaemon", () => {
  it("reads daemon info from <home>/config.json", () => {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify(validConfig));

    const ctx = discoverBridgeDaemon({ home: tmpHome });

    expect(ctx.dbPath).toBe("/abs/.claude-bridge/bridge.db");
    expect(ctx.socket).toBe("/abs/.claude-bridge/daemon.sock");
    expect(ctx.mcpEndpoint).toBe("stdio");
    expect(ctx.eventsLog).toBe("/abs/.claude-bridge/events.log");
    expect(ctx.agentsDir).toBe("/abs/.claude-bridge/agents");
    expect(ctx.version).toBe("0.6.2");
    expect(ctx.compat).toBe(">=0.1.0 <1.0.0");
  });

  it("identifies the default dashboard install", () => {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify(validConfig));

    const ctx = discoverBridgeDaemon({ home: tmpHome });

    expect(ctx.dashboard).not.toBeNull();
    expect(ctx.dashboard?.version).toBe("0.1.0");
    expect(ctx.dashboard?.path).toBe("/abs/.claude-bridge/dashboards/v0.1.0");
    expect(ctx.dashboard?.default).toBe(true);
  });

  it("returns dashboard=null when no dashboards installed yet", () => {
    const cfg = { ...validConfig, dashboards: [] };
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify(cfg));

    const ctx = discoverBridgeDaemon({ home: tmpHome });

    expect(ctx.dashboard).toBeNull();
  });

  it("throws BridgeNotInstalledError when config.json missing", () => {
    expect(() => discoverBridgeDaemon({ home: tmpHome })).toThrow(
      BridgeNotInstalledError,
    );
  });

  it("error message points user to bridge install", () => {
    let caught: unknown;
    try {
      discoverBridgeDaemon({ home: tmpHome });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BridgeNotInstalledError);
    expect((caught as Error).message).toMatch(/bridge install/i);
    expect((caught as Error).message).toContain(tmpHome);
  });

  it("throws on malformed JSON", () => {
    writeFileSync(join(tmpHome, "config.json"), "{ this is not json");

    expect(() => discoverBridgeDaemon({ home: tmpHome })).toThrow();
  });

  it("respects CLAUDE_BRIDGE_HOME env when home option not given", () => {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify(validConfig));

    const orig = process.env.CLAUDE_BRIDGE_HOME;
    process.env.CLAUDE_BRIDGE_HOME = tmpHome;
    try {
      const ctx = discoverBridgeDaemon();
      expect(ctx.dbPath).toBe("/abs/.claude-bridge/bridge.db");
    } finally {
      if (orig === undefined) delete process.env.CLAUDE_BRIDGE_HOME;
      else process.env.CLAUDE_BRIDGE_HOME = orig;
    }
  });
});
