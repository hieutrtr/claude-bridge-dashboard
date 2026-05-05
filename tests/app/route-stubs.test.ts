import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ROUTES = ["agents", "tasks", "loops", "schedules", "cost", "login"] as const;

describe("Phase 1 route stubs", () => {
  for (const route of ROUTES) {
    it(`/${route} has a page.tsx file`, () => {
      const path = join(REPO_ROOT, "app", route, "page.tsx");
      expect(existsSync(path)).toBe(true);
    });

    it(`/${route} page has a default export`, async () => {
      const mod = await import(`../../app/${route}/page.tsx`);
      expect(typeof mod.default).toBe("function");
    });
  }
});
