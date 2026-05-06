// P3-T3 — `<StartLoopDialogView>` view-only markup tests. Same shape
// as `tests/app/dispatch-dialog.test.ts` (pure `renderToStaticMarkup`
// — no DOM, no useState). The interactive `<StartLoopDialog>` wrapper
// is exercised by Playwright (Phase 3 step 11).

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  StartLoopDialogView,
  type StartLoopDialogViewProps,
} from "../../src/components/start-loop-dialog";
import type { Agent } from "../../src/server/dto";

const AGENTS_FIXTURE: Agent[] = [
  {
    name: "alpha",
    projectDir: "/tmp/alpha",
    model: "sonnet",
    state: "idle",
    lastTaskAt: null,
    totalTasks: 0,
  },
  {
    name: "beta",
    projectDir: "/tmp/beta",
    model: "opus",
    state: "running",
    lastTaskAt: null,
    totalTasks: 3,
  },
];

function baseProps(
  overrides: Partial<StartLoopDialogViewProps> = {},
): StartLoopDialogViewProps {
  return {
    open: true,
    status: "idle",
    agents: AGENTS_FIXTURE,
    agentName: "alpha",
    goal: "",
    doneWhenPrefix: "manual",
    doneWhenValue: "",
    maxIterations: "",
    maxCostUsd: "",
    passThreshold: "",
    loopType: "bridge",
    planFirst: true,
    completedLoopId: null,
    errorCode: null,
    errorMessage: null,
    csrfMissing: false,
    ...overrides,
  };
}

function submitButton(html: string): string | null {
  const m = html.match(/<button[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/);
  return m ? m[0]! : null;
}

describe("<StartLoopDialogView>", () => {
  it("renders nothing observable when open=false", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(baseProps({ open: false })),
    );
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Start loop");
  });

  it("renders a loading placeholder when status='loading'", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(baseProps({ status: "loading", agents: [] })),
    );
    expect(html).toContain("Loading agents");
    // No form yet — no goal textarea.
    expect(html).not.toMatch(/name="goal"/);
  });

  it("renders the full form on idle (agents + goal + done_when + numerics + plan_first)", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(
        baseProps({
          goal: "ship it",
          doneWhenPrefix: "manual",
          doneWhenValue: "",
        }),
      ),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Start loop");
    expect(html).toMatch(/name="agentName"/);
    expect(html).toContain(">alpha<");
    expect(html).toContain(">beta<");
    expect(html).toMatch(/name="goal"/);
    expect(html).toMatch(/name="doneWhenPrefix"/);
    expect(html).toMatch(/name="doneWhenValue"/);
    expect(html).toMatch(/name="maxIterations"/);
    expect(html).toMatch(/name="maxCostUsd"/);
    expect(html).toMatch(/name="passThreshold"/);
    expect(html).toMatch(/name="planFirst"/);
    expect(html).toMatch(/name="loopType"/);
  });

  it("manual + empty value composes 'manual:' (server input preview)", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(
        baseProps({
          goal: "x",
          doneWhenPrefix: "manual",
          doneWhenValue: "",
        }),
      ),
    );
    // The preview line surfaces the composed string verbatim.
    expect(html).toContain("manual:");
    // Submit is enabled — manual with empty value is valid.
    const btn = submitButton(html)!;
    expect(btn).not.toMatch(/\sdisabled(=|>|\s)/);
  });

  it("non-manual prefix with empty value disables submit", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(
        baseProps({
          goal: "x",
          doneWhenPrefix: "command",
          doneWhenValue: "",
        }),
      ),
    );
    const btn = submitButton(html)!;
    expect(btn).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("disables submit when goal is empty", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(baseProps({ goal: "" })),
    );
    const btn = submitButton(html)!;
    expect(btn).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("disables submit while submitting", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(baseProps({ status: "submitting", goal: "x" })),
    );
    const btn = submitButton(html)!;
    expect(btn).toMatch(/\sdisabled(=|>|\s)/);
    // Button label flips to "Starting…".
    expect(btn).toContain("Starting");
  });

  it("renders a Loop link on success", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(
        baseProps({
          status: "success",
          completedLoopId: "loop-abc",
        }),
      ),
    );
    expect(html).toContain("/loops/loop-abc");
    expect(html).toContain("Loop loop-abc");
  });

  it("renders the typed error code + message on error and re-enables submit", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(
        baseProps({
          status: "error",
          goal: "x",
          errorCode: "TIMEOUT",
          errorMessage: "Daemon did not respond within timeout",
        }),
      ),
    );
    expect(html).toContain("TIMEOUT");
    expect(html).toContain("Daemon did not respond within timeout");
    const btn = submitButton(html)!;
    expect(btn).not.toMatch(/\sdisabled(=|>|\s)/);
  });

  it("preserves form values on a rolled-back error state", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(
        baseProps({
          status: "error",
          agentName: "beta",
          goal: "ship it",
          doneWhenPrefix: "command",
          doneWhenValue: "bun test",
          maxIterations: "8",
          maxCostUsd: "5",
          passThreshold: "2",
          loopType: "agent",
          planFirst: false,
          errorCode: "TIMEOUT",
          errorMessage: "Daemon did not respond within timeout",
        }),
      ),
    );
    // Form is still rendered.
    expect(html).toMatch(/name="agentName"/);
    expect(html).toMatch(/name="goal"/);
    // Goal textarea content preserved (textarea uses inner text).
    const goalMatch = html.match(
      /<textarea[^>]*name="goal"[^>]*>([\s\S]*?)<\/textarea>/,
    );
    expect(goalMatch).not.toBeNull();
    expect(goalMatch![1]).toBe("ship it");
    // doneWhen value preserved.
    const dwValMatch = html.match(
      /<input[^>]*name="doneWhenValue"[^>]*value="bun test"[^>]*\/?>/,
    );
    expect(dwValMatch).not.toBeNull();
    // beta selected.
    expect(html).toMatch(
      /<option[^>]*value="beta"[^>]*selected[^>]*>beta<\/option>/,
    );
    // command preset selected.
    expect(html).toMatch(
      /<option[^>]*value="command"[^>]*selected[^>]*>Shell command<\/option>/,
    );
    // agent loopType selected.
    expect(html).toMatch(
      /<option[^>]*value="agent"[^>]*selected[^>]*>agent[^<]*<\/option>/,
    );
    // numeric values preserved.
    expect(html).toMatch(/<input[^>]*name="maxIterations"[^>]*value="8"/);
    expect(html).toMatch(/<input[^>]*name="maxCostUsd"[^>]*value="5"/);
    expect(html).toMatch(/<input[^>]*name="passThreshold"[^>]*value="2"/);
    // planFirst unchecked — checkbox should NOT have a `checked` attribute.
    const planMatch = html.match(/<input[^>]*name="planFirst"[^>]*\/?>/);
    expect(planMatch).not.toBeNull();
    expect(planMatch![0]).not.toMatch(/\schecked(=|>|\s)/);
  });

  it("renders a no-agents hint when the agents list is empty post-load", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(baseProps({ status: "idle", agents: [] })),
    );
    expect(html).toContain("No agents available");
    expect(html).not.toMatch(/name="goal"/);
  });

  it("disables submit and shows a session hint when csrfMissing=true", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(baseProps({ csrfMissing: true, goal: "x" })),
    );
    expect(html).toContain("session expired");
    const btn = submitButton(html)!;
    expect(btn).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("disables submit when maxIterations is out of range (0)", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(baseProps({ goal: "x", maxIterations: "0" })),
    );
    const btn = submitButton(html)!;
    expect(btn).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("disables submit when maxIterations exceeds 200", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(baseProps({ goal: "x", maxIterations: "201" })),
    );
    const btn = submitButton(html)!;
    expect(btn).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("disables submit when maxCostUsd is non-positive", () => {
    const html = renderToStaticMarkup(
      StartLoopDialogView(baseProps({ goal: "x", maxCostUsd: "0" })),
    );
    const btn = submitButton(html)!;
    expect(btn).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("does NOT render the goal text inside any audit-style attribute", () => {
    // Sanity: privacy contract is server-side, but we also assert here
    // that the dialog itself never echoes the goal into a hidden field
    // or data attribute. The textarea legitimately holds the goal as
    // its inner text — that's fine, the user typed it.
    const html = renderToStaticMarkup(
      StartLoopDialogView(baseProps({ goal: "SECRET_GOAL_TEXT_DO_NOT_LEAK" })),
    );
    // No data-* / aria-* attribute carries the goal text.
    expect(html).not.toMatch(
      /data-[a-z-]+="SECRET_GOAL_TEXT_DO_NOT_LEAK"/,
    );
    expect(html).not.toMatch(
      /aria-[a-z-]+="SECRET_GOAL_TEXT_DO_NOT_LEAK"/,
    );
    // It IS in the textarea — that's the user-typed value.
    expect(html).toContain("SECRET_GOAL_TEXT_DO_NOT_LEAK");
  });
});
