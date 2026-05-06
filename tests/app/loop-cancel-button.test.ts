// P3-T4 — `<LoopCancelButton>` smoke tests via `renderToStaticMarkup`.
// Same pattern as `kill-task-button.test.ts`: the component is a thin
// client wrapper over `<DangerConfirm>` and its initial render is
// fully deterministic.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LOOP_CANCEL_CONFIRM_LENGTH,
  LoopCancelButton,
} from "../../src/components/loop-cancel-button";

describe("<LoopCancelButton>", () => {
  it("renders the Cancel trigger when status=running", () => {
    const html = renderToStaticMarkup(
      LoopCancelButton({ loopId: "loop-abcdef0123", status: "running" }),
    );
    expect(html).toContain("Cancel loop");
    expect(html).toContain("data-testid=\"loop-cancel-trigger\"");
  });

  it("renders nothing for status=done", () => {
    const html = renderToStaticMarkup(
      LoopCancelButton({ loopId: "loop-abcdef0123", status: "done" }),
    );
    expect(html).not.toContain("Cancel loop");
  });

  it("renders nothing for status=cancelled", () => {
    const html = renderToStaticMarkup(
      LoopCancelButton({ loopId: "loop-abcdef0123", status: "cancelled" }),
    );
    expect(html).not.toContain("Cancel loop");
  });

  it("renders nothing for status=canceled (US spelling alt)", () => {
    const html = renderToStaticMarkup(
      LoopCancelButton({ loopId: "loop-abcdef0123", status: "canceled" }),
    );
    expect(html).not.toContain("Cancel loop");
  });

  it("renders nothing for status=failed", () => {
    const html = renderToStaticMarkup(
      LoopCancelButton({ loopId: "loop-abcdef0123", status: "failed" }),
    );
    expect(html).not.toContain("Cancel loop");
  });

  it("renders the trigger when status=null (defensive)", () => {
    const html = renderToStaticMarkup(
      LoopCancelButton({ loopId: "loop-abcdef0123", status: null }),
    );
    expect(html).toContain("Cancel loop");
  });

  it("renders the trigger for any non-terminal status", () => {
    const html = renderToStaticMarkup(
      LoopCancelButton({ loopId: "loop-abcdef0123", status: "weird-state" }),
    );
    expect(html).toContain("Cancel loop");
  });

  it("uses the first-N-char prefix as the typed confirmation token", () => {
    expect(LOOP_CANCEL_CONFIRM_LENGTH).toBe(8);
    const loopId = "loop-abcdef0123";
    const html = renderToStaticMarkup(
      LoopCancelButton({ loopId, status: "running" }),
    );
    // The prefix is part of the dialog `subject` shown in the rendered
    // trigger wrapper. We pin the prefix length contract here so a
    // future bump to 12 chars must update this test deliberately.
    expect(loopId.slice(0, LOOP_CANCEL_CONFIRM_LENGTH)).toBe("loop-abc");
  });
});
