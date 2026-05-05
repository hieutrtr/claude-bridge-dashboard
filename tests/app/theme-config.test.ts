// T12 — static analysis of the theme contract. Reads app/layout.tsx +
// app/globals.css as text to verify the FOUC guard, ThemeProvider
// configuration, and light/dark token parity. These textual assertions
// freeze the contract so future edits can't silently break it.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const layoutSrc = readFileSync(join(REPO_ROOT, "app", "layout.tsx"), "utf8");
const cssSrc = readFileSync(join(REPO_ROOT, "app", "globals.css"), "utf8");

describe("app/layout.tsx — theme contract", () => {
  it("sets suppressHydrationWarning on <html>", () => {
    expect(layoutSrc).toMatch(/<html[^>]*\bsuppressHydrationWarning\b/);
  });

  it("uses class strategy on ThemeProvider", () => {
    expect(layoutSrc).toMatch(/attribute=["']class["']/);
  });

  it("defaults to dark theme", () => {
    expect(layoutSrc).toMatch(/defaultTheme=["']dark["']/);
  });

  it("disables system theme following", () => {
    expect(layoutSrc).toMatch(/enableSystem=\{false\}/);
  });

  it("disables CSS transitions on theme change to prevent flash", () => {
    expect(layoutSrc).toMatch(/disableTransitionOnChange/);
  });
});

const REQUIRED_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--primary",
  "--primary-foreground",
  "--border",
  "--input",
  "--ring",
];

function tokensInBlock(blockHeader: string): Set<string> {
  // crude block extractor: find `<header> {` then read until matching close
  const idx = cssSrc.indexOf(blockHeader);
  if (idx < 0) return new Set();
  const openBrace = cssSrc.indexOf("{", idx);
  if (openBrace < 0) return new Set();
  let depth = 1;
  let i = openBrace + 1;
  while (i < cssSrc.length && depth > 0) {
    if (cssSrc[i] === "{") depth++;
    else if (cssSrc[i] === "}") depth--;
    if (depth === 0) break;
    i++;
  }
  const body = cssSrc.slice(openBrace + 1, i);
  const out = new Set<string>();
  for (const line of body.split("\n")) {
    const m = line.trim().match(/^(--[a-z0-9-]+)\s*:/i);
    if (m) out.add(m[1]);
  }
  return out;
}

describe("app/globals.css — token parity", () => {
  const lightTokens = tokensInBlock(":root");
  const darkTokens = tokensInBlock(".dark");

  it(":root block exists and defines tokens", () => {
    expect(lightTokens.size).toBeGreaterThan(0);
  });

  it(".dark block exists and defines tokens", () => {
    expect(darkTokens.size).toBeGreaterThan(0);
  });

  for (const t of REQUIRED_TOKENS) {
    it(`:root defines ${t}`, () => {
      expect(lightTokens.has(t)).toBe(true);
    });
    it(`.dark defines ${t}`, () => {
      expect(darkTokens.has(t)).toBe(true);
    });
  }

  it("every :root token has a .dark counterpart (parity)", () => {
    const missing: string[] = [];
    for (const t of lightTokens) {
      if (t === "--radius") continue; // shape/sizing token, not colour
      if (!darkTokens.has(t)) missing.push(t);
    }
    expect(missing).toEqual([]);
  });
});
