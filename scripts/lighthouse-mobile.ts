// P4-T07 — Lighthouse mobile audit runner. Boots the dashboard against
// the Playwright fixture DB (so there is real data on the routes), logs
// in with the fixture password to obtain a session cookie, then runs a
// Lighthouse mobile audit against each route under audit.
//
// Output: docs/tasks/phase-4/lighthouse/<slug>.report.json (full
// report) plus a `summary.json` with the four category scores per
// route. The summary is what the T07 acceptance test reads — we keep it
// out of git ignore to make the gate inspectable in PRs.
//
// Usage: `bun run scripts/lighthouse-mobile.ts` — assumes Chrome is
// installed (the script falls back gracefully if `chrome-launcher`
// can't find a binary on this host).
//
// Why programmatic Lighthouse: the CLI doesn't preserve cookies across
// requests well, and the dashboard auth gate redirects to /login if
// the session is missing. The chrome-launcher + node-lighthouse pairing
// lets us use `extraHeaders.cookie` for an authenticated audit and
// emit JSON that the test suite can parse.

/* eslint-disable no-console */

import {
  spawn,
  spawnSync,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  FIXTURE_CLAUDE_HOME,
  FIXTURE_DB,
  FIXTURE_JWT_SECRET,
  FIXTURE_PASSWORD,
} from "../tests/e2e/fixture";

const PORT = Number(process.env.LIGHTHOUSE_PORT ?? "3110");
const BASE_URL = `http://localhost:${PORT}`;
const ROUTES: ReadonlyArray<{ path: string; slug: string }> = [
  { path: "/", slug: "root" },
  { path: "/agents", slug: "agents" },
  { path: "/tasks", slug: "tasks" },
  { path: "/loops", slug: "loops" },
  { path: "/schedules", slug: "schedules" },
  { path: "/cost", slug: "cost" },
  { path: "/audit", slug: "audit" },
  { path: "/settings/users", slug: "users" },
];

const OUTPUT_DIR = join(process.cwd(), "docs/tasks/phase-4/lighthouse");

interface CategoryScores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

async function ensureFixture() {
  if (!existsSync(FIXTURE_DB)) {
    console.log("[lighthouse] seeding Playwright fixture DB…");
    const { default: globalSetup } = await import("../tests/e2e/global-setup");
    await globalSetup();
  }
}

function buildDashboard(): void {
  if (process.env.LIGHTHOUSE_SKIP_BUILD === "1") {
    console.log("[lighthouse] LIGHTHOUSE_SKIP_BUILD=1 — skipping `next build`");
    return;
  }
  console.log("[lighthouse] running `next build` for production perf parity…");
  const out = spawnSync("bun", ["run", "next", "build"], {
    env: {
      ...process.env,
      BRIDGE_DB: FIXTURE_DB,
      CLAUDE_HOME: FIXTURE_CLAUDE_HOME,
      DASHBOARD_PASSWORD: FIXTURE_PASSWORD,
      JWT_SECRET: FIXTURE_JWT_SECRET,
      NODE_ENV: "production",
    },
    stdio: "inherit",
  });
  if (out.status !== 0) {
    throw new Error(`next build exited with code ${out.status}`);
  }
}

function startDashboard(): ChildProcessByStdio<null, Readable, Readable> {
  console.log(`[lighthouse] starting dashboard on :${PORT}…`);
  const child = spawn(
    "bun",
    ["run", "next", "start", "--port", String(PORT)],
    {
      env: {
        ...process.env,
        BRIDGE_DB: FIXTURE_DB,
        CLAUDE_HOME: FIXTURE_CLAUDE_HOME,
        DASHBOARD_PASSWORD: FIXTURE_PASSWORD,
        JWT_SECRET: FIXTURE_JWT_SECRET,
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (b: Buffer) => {
    const s = b.toString();
    if (s.includes("Ready") || s.includes("compiled") || s.includes("Local:")) {
      process.stdout.write(`[next] ${s}`);
    }
  });
  child.stderr?.on("data", (b: Buffer) => {
    const s = b.toString();
    if (s.toLowerCase().includes("error")) {
      process.stderr.write(`[next] ${s}`);
    }
  });
  return child;
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/login`, { redirect: "manual" });
      if (r.status >= 200 && r.status < 500) {
        return;
      }
    } catch {
      // not yet
    }
    await sleep(750);
  }
  throw new Error("dashboard did not become ready within timeout");
}

async function login(): Promise<string> {
  console.log("[lighthouse] obtaining session cookie via /api/auth/login…");
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: FIXTURE_PASSWORD }),
    redirect: "manual",
  });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  // The header is comma-separated for multi-cookie payloads; pluck both
  // the session and (any) CSRF token so the audit's GET requests
  // already carry both.
  const cookies = parseSetCookie(setCookie);
  if (cookies.length === 0) {
    throw new Error("login did not set any cookies");
  }
  return cookies.join("; ");
}

function parseSetCookie(header: string): string[] {
  if (!header) return [];
  // Split on comma followed by a non-attribute token name. Naive but
  // sufficient for our two cookies.
  const parts = header.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  return parts.map((p) => p.split(";")[0].trim()).filter(Boolean);
}

interface RouteResult {
  slug: string;
  path: string;
  scores: CategoryScores;
  passed: boolean;
}

async function runAudit(
  cookieHeader: string,
): Promise<RouteResult[]> {
  const lh = (await import("lighthouse")).default;
  const chromeLauncher = await import("chrome-launcher");
  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });
  console.log(`[lighthouse] chrome up on port ${chrome.port}`);
  try {
    const results: RouteResult[] = [];
    for (const route of ROUTES) {
      console.log(`[lighthouse] auditing ${route.path}…`);
      const url = `${BASE_URL}${route.path}`;
      const runResult = await lh(
        url,
        {
          port: chrome.port,
          output: ["json"],
          logLevel: "error",
          extraHeaders: { cookie: cookieHeader },
          // Mobile preset + 4G throttling are baked in by formFactor.
          formFactor: "mobile",
          screenEmulation: {
            mobile: true,
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
            disabled: false,
          },
          throttling: {
            // Slow 4G (Lighthouse mobile preset).
            rttMs: 150,
            throughputKbps: 1638.4,
            cpuSlowdownMultiplier: 4,
            requestLatencyMs: 0,
            downloadThroughputKbps: 0,
            uploadThroughputKbps: 0,
          },
          onlyCategories: [
            "performance",
            "accessibility",
            "best-practices",
            "seo",
          ],
        },
        // Mobile config preset.
        undefined,
      );
      if (!runResult) {
        throw new Error(`Lighthouse returned no result for ${route.path}`);
      }
      const lhr = runResult.lhr;
      const scores: CategoryScores = {
        performance: scoreOf(lhr, "performance"),
        accessibility: scoreOf(lhr, "accessibility"),
        bestPractices: scoreOf(lhr, "best-practices"),
        seo: scoreOf(lhr, "seo"),
      };
      writeFileSync(
        join(OUTPUT_DIR, `${route.slug}.report.json`),
        JSON.stringify(lhr, null, 2),
      );
      const passed =
        scores.performance >= 90 &&
        scores.accessibility >= 90 &&
        scores.bestPractices >= 90;
      results.push({ slug: route.slug, path: route.path, scores, passed });
      console.log(
        `[lighthouse] ${route.path} → perf=${scores.performance} a11y=${scores.accessibility} bp=${scores.bestPractices} seo=${scores.seo} ${passed ? "PASS" : "FAIL"}`,
      );
    }
    return results;
  } finally {
    await chrome.kill();
  }
}

function scoreOf(
  lhr: { categories: Record<string, { score: number | null }> },
  key: string,
): number {
  const cat = lhr.categories[key];
  if (!cat || typeof cat.score !== "number") return 0;
  return Math.round(cat.score * 100);
}

async function main() {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  await ensureFixture();
  buildDashboard();
  const dashboard = startDashboard();
  let exitCode = 0;
  try {
    await waitForReady();
    const cookie = await login();
    const results = await runAudit(cookie);
    const summary = {
      generatedAt: new Date().toISOString(),
      routes: results,
      passedAll: results.every((r) => r.passed),
    };
    writeFileSync(
      join(OUTPUT_DIR, "summary.json"),
      JSON.stringify(summary, null, 2),
    );
    if (!summary.passedAll) {
      console.error("[lighthouse] one or more routes did not meet ≥90 gate");
      exitCode = 1;
    } else {
      console.log("[lighthouse] all routes ≥90 — PASS");
    }
  } catch (err) {
    console.error("[lighthouse] error:", err);
    exitCode = 2;
  } finally {
    dashboard.kill("SIGTERM");
    await sleep(250);
  }
  process.exit(exitCode);
}

void main();
