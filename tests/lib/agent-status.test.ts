import { describe, it, expect } from "bun:test";

import { agentStatusBadge } from "../../src/lib/agent-status";

describe("agentStatusBadge", () => {
  it("maps 'running' to running variant", () => {
    expect(agentStatusBadge("running")).toEqual({
      label: "Running",
      variant: "running",
    });
  });

  it("maps 'idle' to idle variant", () => {
    expect(agentStatusBadge("idle")).toEqual({
      label: "Idle",
      variant: "idle",
    });
  });

  it("maps 'created' to idle variant with Created label", () => {
    expect(agentStatusBadge("created")).toEqual({
      label: "Created",
      variant: "idle",
    });
  });

  it("maps 'errored' to error variant", () => {
    expect(agentStatusBadge("errored")).toEqual({
      label: "Errored",
      variant: "error",
    });
  });

  it("maps 'killed' to error variant", () => {
    expect(agentStatusBadge("killed")).toEqual({
      label: "Killed",
      variant: "error",
    });
  });

  it("treats null as Unknown", () => {
    expect(agentStatusBadge(null)).toEqual({
      label: "Unknown",
      variant: "unknown",
    });
  });

  it("treats empty string as Unknown", () => {
    expect(agentStatusBadge("")).toEqual({
      label: "Unknown",
      variant: "unknown",
    });
  });

  it("falls back to Unknown for an unrecognised state", () => {
    expect(agentStatusBadge("some-future-state")).toEqual({
      label: "Unknown",
      variant: "unknown",
    });
  });
});
