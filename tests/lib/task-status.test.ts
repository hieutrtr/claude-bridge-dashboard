import { describe, it, expect } from "bun:test";
import { taskStatusBadge } from "../../src/lib/task-status";

describe("taskStatusBadge", () => {
  it("maps 'pending' to idle", () => {
    expect(taskStatusBadge("pending")).toEqual({
      label: "Pending",
      variant: "idle",
    });
  });

  it("maps 'queued' to idle", () => {
    expect(taskStatusBadge("queued")).toEqual({
      label: "Queued",
      variant: "idle",
    });
  });

  it("maps 'running' to running", () => {
    expect(taskStatusBadge("running")).toEqual({
      label: "Running",
      variant: "running",
    });
  });

  it("maps 'done' to running variant (a 'success' variant doesn't exist yet)", () => {
    // We intentionally reuse the existing variants until T12 polishes the
    // shared <Badge> palette. The label disambiguates.
    const out = taskStatusBadge("done");
    expect(out.label).toBe("Done");
    expect(["running", "idle"]).toContain(out.variant);
  });

  it("maps 'failed' to error", () => {
    expect(taskStatusBadge("failed")).toEqual({
      label: "Failed",
      variant: "error",
    });
  });

  it("maps 'killed' to error", () => {
    expect(taskStatusBadge("killed")).toEqual({
      label: "Killed",
      variant: "error",
    });
  });

  it("returns Unknown for null", () => {
    expect(taskStatusBadge(null)).toEqual({
      label: "Unknown",
      variant: "unknown",
    });
  });

  it("returns Unknown for an unrecognized future state", () => {
    expect(taskStatusBadge("future-state-xyz")).toEqual({
      label: "Unknown",
      variant: "unknown",
    });
  });
});
