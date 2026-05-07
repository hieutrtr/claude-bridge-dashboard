// P4-T07 — Acceptance gate: parses the on-disk Lighthouse summary
// (committed to docs/tasks/phase-4/lighthouse/summary.json) and asserts
// every audited route met the ≥ 90 threshold for performance,
// accessibility, and best-practices.
//
// Why this lives in `tests/app/` and not in CI: the test reads a
// committed JSON. If a future PR regresses mobile perf, the gate
// surfaces in `bun test` immediately; the dev re-runs
// `bun run lighthouse:mobile`, commits the updated summary, and
// either lands the perf fix or documents an exemption with a
// follow-up ticket. Without this gate, an `Image` import or a 200kb
// chart would silently sneak past code review.

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SUMMARY_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "tasks",
  "phase-4",
  "lighthouse",
  "summary.json",
);

interface RouteSummary {
  slug: string;
  path: string;
  scores: {
    performance: number;
    accessibility: number;
    bestPractices: number;
    seo: number;
  };
  passed: boolean;
}

interface Summary {
  generatedAt: string;
  routes: RouteSummary[];
  passedAll: boolean;
}

const REQUIRED_ROUTES = [
  "/",
  "/agents",
  "/tasks",
  "/loops",
  "/schedules",
  "/cost",
  "/audit",
  "/settings/users",
] as const;

describe("Lighthouse mobile summary (T07 acceptance)", () => {
  it("summary.json exists — run `bun run lighthouse:mobile` to refresh", () => {
    expect(existsSync(SUMMARY_PATH)).toBe(true);
  });

  it("covers every required route", () => {
    const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8")) as Summary;
    const audited = summary.routes.map((r) => r.path).sort();
    const required = [...REQUIRED_ROUTES].sort();
    expect(audited).toEqual(required);
  });

  it("every route meets perf / a11y / best-practices ≥ 90", () => {
    const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8")) as Summary;
    for (const route of summary.routes) {
      // Per-category breakdown so a regression points at the right
      // axis instead of a generic "all four scores < 90".
      expect(route.scores.performance).toBeGreaterThanOrEqual(90);
      expect(route.scores.accessibility).toBeGreaterThanOrEqual(90);
      expect(route.scores.bestPractices).toBeGreaterThanOrEqual(90);
      expect(route.passed).toBe(true);
    }
    expect(summary.passedAll).toBe(true);
  });

  it("generatedAt is a valid ISO timestamp", () => {
    const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8")) as Summary;
    expect(Number.isFinite(Date.parse(summary.generatedAt))).toBe(true);
  });
});
