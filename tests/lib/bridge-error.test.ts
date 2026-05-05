// T11 — bridge-error predicate. Centralizes the BridgeNotInstalledError
// discriminator so the error boundary, future surface pages, and tests
// share a single check. Name-based (not instanceof) so it survives
// React server/client error serialization, which strips the prototype.

import { describe, it, expect } from "bun:test";

import {
  isBridgeNotInstalledError,
  BRIDGE_NOT_INSTALLED_NAME,
} from "../../src/lib/bridge-error";
import { BridgeNotInstalledError } from "../../src/lib/discovery";

describe("isBridgeNotInstalledError", () => {
  it("returns true for a real BridgeNotInstalledError instance", () => {
    const err = new BridgeNotInstalledError("/tmp/cb-home");
    expect(isBridgeNotInstalledError(err)).toBe(true);
  });

  it("returns true for a plain object with the discriminator name", () => {
    // Simulates Next.js's serialized error prop crossing the
    // server→client boundary: `instanceof` fails, but `.name` survives.
    const wireShape = {
      name: "BridgeNotInstalledError",
      message: "config not found",
    };
    expect(isBridgeNotInstalledError(wireShape)).toBe(true);
  });

  it("returns false for a generic Error", () => {
    expect(isBridgeNotInstalledError(new Error("boom"))).toBe(false);
  });

  it("returns false for an Error with a different name", () => {
    const err = new Error("nope");
    err.name = "TypeError";
    expect(isBridgeNotInstalledError(err)).toBe(false);
  });

  it("returns false for null / undefined / primitives", () => {
    expect(isBridgeNotInstalledError(null)).toBe(false);
    expect(isBridgeNotInstalledError(undefined)).toBe(false);
    expect(isBridgeNotInstalledError("BridgeNotInstalledError")).toBe(false);
    expect(isBridgeNotInstalledError(42)).toBe(false);
    expect(isBridgeNotInstalledError(true)).toBe(false);
  });

  it("returns false for an object missing the name field", () => {
    expect(isBridgeNotInstalledError({})).toBe(false);
    expect(isBridgeNotInstalledError({ message: "x" })).toBe(false);
  });

  it("exports the canonical name as a constant", () => {
    expect(BRIDGE_NOT_INSTALLED_NAME).toBe("BridgeNotInstalledError");
  });
});
