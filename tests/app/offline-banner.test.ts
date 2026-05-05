// T11 — `<OfflineBanner>` server component. Reused by the root error
// boundary when `BridgeNotInstalledError` fires. Pure presentational
// (Card-shaped block) — heading, configured config-home path,
// remediation copy. No client interactivity (the retry button lives in
// the boundary, not in the banner itself).

import { describe, it, expect } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { OfflineBanner } from "../../src/components/offline-banner";

describe("<OfflineBanner>", () => {
  it("renders the configured home path", () => {
    const html = renderToStaticMarkup(
      OfflineBanner({ home: "/tmp/.claude-bridge" }),
    );
    expect(html).toContain("/tmp/.claude-bridge");
  });

  it("renders the explicit configPath when provided", () => {
    const html = renderToStaticMarkup(
      OfflineBanner({
        home: "/tmp/.claude-bridge",
        configPath: "/tmp/.claude-bridge/config.json",
      }),
    );
    expect(html).toContain("/tmp/.claude-bridge/config.json");
  });

  it("renders the remediation command", () => {
    const html = renderToStaticMarkup(
      OfflineBanner({ home: "/x/.claude-bridge" }),
    );
    expect(html).toContain("bridge install");
  });

  it("renders the 'Daemon offline' heading", () => {
    const html = renderToStaticMarkup(
      OfflineBanner({ home: "/x/.claude-bridge" }),
    );
    expect(html).toMatch(/Daemon offline/i);
  });
});
