// T06 — markdown helper. Centralises the rehype plugin list + byte cap so
// the procedure clip and the page-render code stay in sync. Pure assertions
// against exported constants — no jsdom needed.

import { describe, it, expect } from "bun:test";
import rehypeSanitize from "rehype-sanitize";

import {
  MARKDOWN_BYTE_LIMIT,
  MARKDOWN_REHYPE_PLUGINS,
} from "../../src/lib/markdown";

describe("markdown helper", () => {
  it("MARKDOWN_BYTE_LIMIT is exactly 500_000", () => {
    expect(MARKDOWN_BYTE_LIMIT).toBe(500_000);
  });

  it("MARKDOWN_REHYPE_PLUGINS is non-empty", () => {
    expect(Array.isArray(MARKDOWN_REHYPE_PLUGINS)).toBe(true);
    expect(MARKDOWN_REHYPE_PLUGINS.length > 0).toBe(true);
  });

  it("MARKDOWN_REHYPE_PLUGINS includes rehypeSanitize", () => {
    expect(MARKDOWN_REHYPE_PLUGINS.includes(rehypeSanitize)).toBe(true);
  });
});
