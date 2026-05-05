// T11 — loading states. Per the Next.js App Router contract, a
// `loading.tsx` colocated next to `page.tsx` is rendered while the
// server component below is awaiting async data. We ship a root
// `app/loading.tsx` plus per-route skeletons for the three Phase 1
// surfaces with non-trivial layout (agents grid, tasks table, cost
// dashboard). The Loops/Schedules pages are stubs and do not need a
// dedicated skeleton; the root loading falls back automatically.

import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const LOADING_FILES = [
  { route: "(root)", path: ["app", "loading.tsx"], importPath: "../../app/loading" },
  { route: "/agents", path: ["app", "agents", "loading.tsx"], importPath: "../../app/agents/loading" },
  { route: "/tasks", path: ["app", "tasks", "loading.tsx"], importPath: "../../app/tasks/loading" },
  { route: "/cost", path: ["app", "cost", "loading.tsx"], importPath: "../../app/cost/loading" },
] as const;

describe("Phase 1 loading skeletons", () => {
  for (const entry of LOADING_FILES) {
    it(`${entry.route}: file exists`, () => {
      expect(existsSync(join(REPO_ROOT, ...entry.path))).toBe(true);
    });

    it(`${entry.route}: default-exports a function`, async () => {
      const mod = await import(entry.importPath);
      expect(typeof mod.default).toBe("function");
    });

    it(`${entry.route}: renders an animate-pulse skeleton`, async () => {
      const mod = await import(entry.importPath);
      const tree = mod.default();
      const html = renderToStaticMarkup(tree);
      expect(html).toContain("animate-pulse");
    });
  }
});
