// T11 — root error boundary at `app/error.tsx`. Per Next.js App Router
// contract, error boundaries are client components rendered when a
// server component below them throws. The boundary must:
//   - declare "use client" at byte 0
//   - default-export a function taking { error, reset }
//   - branch on `BridgeNotInstalledError` (by name, since the prototype
//     is stripped when crossing the server→client boundary) and render
//     the offline banner copy
//   - render a generic fallback for any other error
//   - present a retry control wired to `reset()`
//
// We render via `react-dom/server.renderToStaticMarkup` — sufficient for
// markup assertions; Playwright in T13 will exercise the click handler.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

const ERROR_TSX = join(import.meta.dir, "..", "..", "app", "error.tsx");

// Build a fake offline error WITHOUT importing BridgeNotInstalledError
// — this verifies the boundary uses name-based discrimination, not
// instanceof, so a serialized error from the RSC payload still routes
// correctly.
function fakeOfflineError(): Error & { digest?: string } {
  const err = new Error(
    "claude-bridge config not found at /tmp/.claude-bridge/config.json " +
      "(CLAUDE_BRIDGE_HOME=/tmp/.claude-bridge). " +
      "Run `bridge install` on the host machine first, then start the dashboard.",
  );
  err.name = "BridgeNotInstalledError";
  // Some Next.js builds also pass a digest; tolerate it.
  Object.assign(err, { digest: "abc123" });
  return err;
}

describe("app/error.tsx (root error boundary)", () => {
  it("declares 'use client' at byte 0", () => {
    const src = readFileSync(ERROR_TSX, "utf-8");
    // Either single or double quotes; must be the first thing in the file.
    expect(src).toMatch(/^["']use client["'];?\s/);
  });

  it("default-exports a function", async () => {
    const mod = await import("../../app/error");
    expect(typeof mod.default).toBe("function");
  });

  it("renders the offline banner for BridgeNotInstalledError", async () => {
    const mod = await import("../../app/error");
    const tree = mod.default({ error: fakeOfflineError(), reset: () => {} });
    const html = renderToStaticMarkup(tree);

    // Heading + remediation copy.
    expect(html).toMatch(/Daemon offline/i);
    expect(html).toContain("bridge install");
    // The configured home path surfaces (extracted from the message
    // text or via a separate field — either is fine).
    expect(html).toContain("/tmp/.claude-bridge");
    // The retry control is present.
    expect(html).toMatch(/<button[^>]*>[^<]*(Try again|Retry|Reload)/i);
    // The generic fallback copy MUST NOT bleed in.
    expect(html).not.toMatch(/Something went wrong/i);
  });

  it("renders the generic fallback for an arbitrary Error", async () => {
    const mod = await import("../../app/error");
    const err = new Error("boom — db connection refused");
    const tree = mod.default({ error: err, reset: () => {} });
    const html = renderToStaticMarkup(tree);

    expect(html).toMatch(/Something went wrong/i);
    // The error message surfaces somewhere visible (typically <pre>).
    expect(html).toContain("boom — db connection refused");
    expect(html).toMatch(/<button[^>]*>[^<]*(Try again|Retry|Reload)/i);
    // Offline-specific copy must NOT show for a generic error.
    expect(html).not.toMatch(/Daemon offline/i);
    expect(html).not.toContain("bridge install");
  });

  it("does not export POST/PUT/PATCH/DELETE handlers (read-only invariant)", async () => {
    const mod = await import("../../app/error");
    expect((mod as Record<string, unknown>).POST).toBeUndefined();
    expect((mod as Record<string, unknown>).PUT).toBeUndefined();
    expect((mod as Record<string, unknown>).PATCH).toBeUndefined();
    expect((mod as Record<string, unknown>).DELETE).toBeUndefined();
  });
});
