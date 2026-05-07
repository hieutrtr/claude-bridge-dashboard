#!/usr/bin/env bun
// P4-T08 — Start wrapper for the dashboard.
//
// Entry point for `bun run start` (alias `bun run start:tunnel`). The
// wrapper detects the optional `--tunnel` flag and either:
//
//   1. Spawns `next start -p <port>` directly (no tunnel — the v0–v3
//      Phase behaviour, unchanged for users who don't pass the flag).
//   2. Spawns `next start -p <port>` AND `cloudflared tunnel --url
//      http://127.0.0.1:<port>`, then prints the public
//      `*.trycloudflare.com` URL the tunnel issues. Both child procs
//      die on SIGINT so a single Ctrl-C tears down the whole stack.
//
// Pure helpers (argv parsing, env validation, URL scraping, install
// hints) live in `src/lib/tunnel.ts`; this file is the side-effect
// shell. Anything testable lives there, anything that requires a
// child process or a TTY lives here.
//
// Security: when --tunnel is set we ENFORCE the v1 ARCH §10
// "public-exposure misuse" gates — RESEND_API_KEY + RESEND_FROM_EMAIL
// must be set so magic-link login is reachable, and DASHBOARD_PASSWORD
// must be ≥ 16 chars and non-default. Refuse to start otherwise.
//
// We deliberately do NOT bundle cloudflared. If it isn't on PATH the
// wrapper prints a per-platform install hint and exits non-zero.

/* eslint-disable no-console */

import { spawn, type ChildProcess } from "node:child_process";

import {
  cloudflaredInstallHint,
  DEFAULT_DASHBOARD_PORT,
  extractTunnelUrl,
  parseStartArgs,
  TUNNEL_LOCAL_HOST,
  validateTunnelEnv,
} from "../src/lib/tunnel";

interface ChildHandle {
  name: string;
  proc: ChildProcess;
}

function spawnNextStart(port: number, passthrough: string[]): ChildProcess {
  const args = ["run", "next", "start", "--port", String(port), ...passthrough];
  console.log(`[start] next start :${port}`);
  return spawn("bun", args, {
    stdio: "inherit",
    env: process.env,
  });
}

function spawnCloudflared(port: number): ChildProcess {
  const args = [
    "tunnel",
    "--url",
    `http://${TUNNEL_LOCAL_HOST}:${port}`,
  ];
  console.log(`[start] cloudflared ${args.join(" ")}`);
  return spawn("cloudflared", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function streamCloudflaredOutput(child: ChildProcess): void {
  let urlPrinted = false;
  const onChunk = (buf: Buffer) => {
    const text = buf.toString();
    process.stderr.write(`[cloudflared] ${text}`);
    if (urlPrinted) return;
    for (const line of text.split(/\r?\n/)) {
      const url = extractTunnelUrl(line);
      if (url) {
        urlPrinted = true;
        console.log("");
        console.log("┌─────────────────────────────────────────────────────────────────");
        console.log(`│ Public dashboard URL: ${url}`);
        console.log("│ Anyone with this URL can REACH the dashboard. Magic-link / owner");
        console.log("│ password auth still applies — keep RESEND_API_KEY + a strong");
        console.log("│ DASHBOARD_PASSWORD set. Press Ctrl-C to tear down the tunnel.");
        console.log("└─────────────────────────────────────────────────────────────────");
        console.log("");
        return;
      }
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
}

function wireSignals(children: ChildHandle[]): void {
  let teardownStarted = false;
  const shutdown = (signal: NodeJS.Signals, code = 0) => {
    if (teardownStarted) return;
    teardownStarted = true;
    console.log(`\n[start] received ${signal} — shutting down children…`);
    for (const { name, proc } of children) {
      if (!proc.killed && proc.exitCode === null) {
        try {
          proc.kill(signal);
        } catch (err) {
          console.error(`[start] failed to ${signal} ${name}:`, err);
        }
      }
    }
    setTimeout(() => process.exit(code), 500).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function bindChildExit(child: ChildHandle, peers: ChildHandle[]): void {
  child.proc.on("exit", (code, signal) => {
    console.log(
      `[start] ${child.name} exited ${signal ? `signal=${signal}` : `code=${code}`}`,
    );
    for (const peer of peers) {
      if (peer === child) continue;
      if (!peer.proc.killed && peer.proc.exitCode === null) {
        peer.proc.kill("SIGTERM");
      }
    }
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  child.proc.on("error", (err: NodeJS.ErrnoException) => {
    if (child.name === "cloudflared" && err.code === "ENOENT") {
      const hint = cloudflaredInstallHint(process.platform);
      console.error(
        "\n[start] `cloudflared` is not on PATH — required for --tunnel.",
      );
      console.error(`        install: ${hint.command}`);
      console.error(`        ${hint.hint}\n`);
      for (const peer of peers) {
        if (peer === child) continue;
        if (!peer.proc.killed && peer.proc.exitCode === null) {
          peer.proc.kill("SIGTERM");
        }
      }
      process.exit(127);
    }
    console.error(`[start] ${child.name} error:`, err);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseStartArgs(argv);
  } catch (err) {
    console.error(`[start] argv error: ${(err as Error).message}`);
    process.exit(2);
  }

  const port = parsed.port || DEFAULT_DASHBOARD_PORT;

  if (!parsed.tunnel) {
    const next = spawnNextStart(port, parsed.passthrough);
    const handle: ChildHandle = { name: "next", proc: next };
    bindChildExit(handle, [handle]);
    wireSignals([handle]);
    return;
  }

  const validation = validateTunnelEnv(process.env);
  if (!validation.ok) {
    console.error(
      "\n[start] refusing to start with --tunnel — environment is not safe to expose:\n",
    );
    for (const error of validation.errors) {
      console.error(`  ✖ ${error}`);
    }
    console.error(
      "\nFix the items above (or drop --tunnel for a localhost-only run) and try again.\n",
    );
    process.exit(3);
  }

  console.log(
    "[start] --tunnel mode: spawning next + cloudflared. Press Ctrl-C to stop both.",
  );
  const next = spawnNextStart(port, parsed.passthrough);
  const tunnel = spawnCloudflared(port);
  const handles: ChildHandle[] = [
    { name: "next", proc: next },
    { name: "cloudflared", proc: tunnel },
  ];
  streamCloudflaredOutput(tunnel);
  for (const handle of handles) bindChildExit(handle, handles);
  wireSignals(handles);
}

void main();
