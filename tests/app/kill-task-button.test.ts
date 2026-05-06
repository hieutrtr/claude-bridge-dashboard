// P2-T11 — `<KillTaskButton>` smoke tests via `renderToStaticMarkup`.
// The component is a thin client wrapper over `<DangerConfirm>`. Its
// initial render (pre-hydration, dialog closed) is fully deterministic
// and is what we assert.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { KillTaskButton } from "../../src/components/kill-task-button";

describe("<KillTaskButton>", () => {
  it("renders nothing for status=done", () => {
    const html = renderToStaticMarkup(
      KillTaskButton({ taskId: 1, agentName: "alpha", status: "done" }),
    );
    expect(html).not.toContain("Kill");
  });

  it("renders nothing for status=failed", () => {
    const html = renderToStaticMarkup(
      KillTaskButton({ taskId: 1, agentName: "alpha", status: "failed" }),
    );
    expect(html).not.toContain("Kill");
  });

  it("renders nothing for status=killed", () => {
    const html = renderToStaticMarkup(
      KillTaskButton({ taskId: 1, agentName: "alpha", status: "killed" }),
    );
    expect(html).not.toContain("Kill");
  });

  it("renders the Kill trigger when status=running", () => {
    const html = renderToStaticMarkup(
      KillTaskButton({ taskId: 42, agentName: "alpha", status: "running" }),
    );
    expect(html).toContain("Kill");
  });

  it("renders the Kill trigger when status=pending", () => {
    const html = renderToStaticMarkup(
      KillTaskButton({ taskId: 42, agentName: "alpha", status: "pending" }),
    );
    expect(html).toContain("Kill");
  });

  it("renders the Kill trigger when status=queued", () => {
    const html = renderToStaticMarkup(
      KillTaskButton({ taskId: 42, agentName: "alpha", status: "queued" }),
    );
    expect(html).toContain("Kill");
  });

  it("renders the Kill trigger for an unknown status (defensive)", () => {
    const html = renderToStaticMarkup(
      KillTaskButton({ taskId: 42, agentName: "alpha", status: "unknown_x" }),
    );
    expect(html).toContain("Kill");
  });

  it("renders the Kill trigger for null status (defensive)", () => {
    const html = renderToStaticMarkup(
      KillTaskButton({ taskId: 42, agentName: "alpha", status: null }),
    );
    expect(html).toContain("Kill");
  });

  it("renders nothing when agentName is null (orphan task — no kill target)", () => {
    const html = renderToStaticMarkup(
      KillTaskButton({ taskId: 42, agentName: null, status: "running" }),
    );
    expect(html).not.toContain("Kill");
  });
});
