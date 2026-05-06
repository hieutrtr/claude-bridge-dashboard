// P3-T6 — `<ScheduleCreateDialogView>` view-only markup tests. Same
// shape as `tests/app/dispatch-dialog.test.ts` and
// `tests/app/loop-start-dialog.test.ts`: pure `renderToStaticMarkup`
// — no DOM, no useState. The interactive `<ScheduleCreateDialog>`
// wrapper is exercised by Playwright (Phase 3 step 11).

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ScheduleCreateDialogView,
  type ScheduleCreateDialogViewProps,
} from "../../src/components/schedule-create-dialog";
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
  overrides: Partial<ScheduleCreateDialogViewProps> = {},
): ScheduleCreateDialogViewProps {
  return {
    open: true,
    status: "idle",
    agents: AGENTS_FIXTURE,
    agentName: "alpha",
    name: "",
    prompt: "run nightly",
    cronValid: true,
    cronMessage: null,
    channelChatId: "",
    completedScheduleId: null,
    errorCode: null,
    errorMessage: null,
    csrfMissing: false,
    forecast: null,
    forecastLoading: false,
    ...overrides,
  };
}

function submitButton(html: string): string | null {
  const m = html.match(/<button[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/);
  return m ? m[0]! : null;
}

describe("<ScheduleCreateDialogView>", () => {
  it("renders nothing observable when open=false", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(baseProps({ open: false })),
    );
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("New schedule");
  });

  it("renders a loading placeholder when status='loading'", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({ status: "loading", agents: [] }),
      ),
    );
    expect(html).toContain("Loading agents");
    // No form yet — no prompt textarea.
    expect(html).not.toMatch(/name="prompt"/);
  });

  it("renders the full form on idle (agent + name + prompt + chat id)", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(baseProps()),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("New schedule");
    expect(html).toMatch(/name="agentName"/);
    expect(html).toContain(">alpha<");
    expect(html).toContain(">beta<");
    expect(html).toMatch(/name="name"/);
    expect(html).toMatch(/name="prompt"/);
    expect(html).toMatch(/name="channelChatId"/);
  });

  it("disables submit when prompt is empty", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(baseProps({ prompt: "" })),
    );
    const btn = submitButton(html)!;
    expect(btn).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("disables submit when cron is invalid", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({
          prompt: "x",
          cronValid: false,
          cronMessage: "Daemon only accepts uniform intervals today",
        }),
      ),
    );
    const btn = submitButton(html)!;
    expect(btn).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("disables submit while submitting + flips label to 'Creating…'", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(baseProps({ status: "submitting" })),
    );
    const btn = submitButton(html)!;
    expect(btn).toMatch(/\sdisabled(=|>|\s)/);
    expect(btn).toContain("Creating");
  });

  it("disables submit + shows session hint when csrfMissing=true", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(baseProps({ csrfMissing: true })),
    );
    expect(html).toContain("session expired");
    const btn = submitButton(html)!;
    expect(btn).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("renders the daemon-assigned id on success", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({
          status: "success",
          completedScheduleId: 42,
        }),
      ),
    );
    expect(html).toContain("Schedule created");
    expect(html).toContain("#42");
    expect(html).toContain("Add another");
    expect(html).toContain("Dismiss");
  });

  it("renders the typed error code + message on error and re-enables submit", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({
          status: "error",
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

  it("renders the no-agents hint when the agents list is empty post-load", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({ status: "idle", agents: [] }),
      ),
    );
    expect(html).toContain("No agents available");
    expect(html).not.toMatch(/name="prompt"/);
  });

  it("does NOT echo the prompt text into any data-/aria- attribute", () => {
    // Privacy contract is server-side, but we also assert here that the
    // dialog itself never echoes the prompt into a hidden field or
    // attribute. The textarea legitimately holds the prompt as its
    // inner text — that's fine, the user typed it.
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({ prompt: "SECRET_PROMPT_DO_NOT_LEAK" }),
      ),
    );
    expect(html).not.toMatch(
      /data-[a-z-]+="SECRET_PROMPT_DO_NOT_LEAK"/,
    );
    expect(html).not.toMatch(
      /aria-[a-z-]+="SECRET_PROMPT_DO_NOT_LEAK"/,
    );
    // It IS in the textarea — that's the user-typed value.
    expect(html).toContain("SECRET_PROMPT_DO_NOT_LEAK");
  });

  it("preserves form values on a rolled-back error state", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({
          status: "error",
          agentName: "beta",
          name: "nightly-tests",
          prompt: "run the suite",
          channelChatId: "telegram-12345",
          errorCode: "MCP_RPC_ERROR",
          errorMessage: "daemon refused",
        }),
      ),
    );
    // Form is still rendered.
    expect(html).toMatch(/name="agentName"/);
    expect(html).toMatch(/name="prompt"/);
    // beta selected.
    expect(html).toMatch(
      /<option[^>]*value="beta"[^>]*selected[^>]*>beta<\/option>/,
    );
    // Name preserved.
    expect(html).toMatch(/<input[^>]*name="name"[^>]*value="nightly-tests"/);
    // Prompt preserved (textarea inner text).
    const promptMatch = html.match(
      /<textarea[^>]*name="prompt"[^>]*>([\s\S]*?)<\/textarea>/,
    );
    expect(promptMatch).not.toBeNull();
    expect(promptMatch![1]).toBe("run the suite");
    // Chat id preserved.
    expect(html).toMatch(
      /<input[^>]*name="channelChatId"[^>]*value="telegram-12345"/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// P3-T9 — cost-forecast block render matrix
// ─────────────────────────────────────────────────────────────────────

describe("<ScheduleCreateDialogView> — cost forecast block", () => {
  it("hides the forecast block when forecast === null and not loading", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(baseProps({ forecast: null, forecastLoading: false })),
    );
    expect(html).not.toContain("Estimated spend");
    expect(html).not.toContain("Insufficient history");
    expect(html).not.toContain("Computing forecast");
  });

  it("renders 'Computing forecast' when forecastLoading=true", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({ forecast: null, forecastLoading: true }),
      ),
    );
    expect(html).toContain("Computing forecast");
  });

  it("renders the dollar estimate + likely range + sample count on happy path", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({
          forecast: {
            sample: 18,
            runsPerMonth: 720,
            avgCostPerRun: 0.0057,
            p10CostPerRun: 0.0032,
            p90CostPerRun: 0.0094,
            monthlyEstimateUsd: 4.12,
            monthlyLowUsd: 2.30,
            monthlyHighUsd: 6.80,
            insufficientHistory: false,
            cadenceUnresolved: false,
          },
          forecastLoading: false,
        }),
      ),
    );
    expect(html).toContain("Estimated spend");
    expect(html).toContain("$4.12");
    expect(html).toContain("$2.30");
    expect(html).toContain("$6.80");
    expect(html).toContain("18 samples");
    expect(html).not.toContain("Insufficient history");
  });

  it("renders the calibration hint + runsPerMonth when insufficientHistory=true", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({
          forecast: {
            sample: 0,
            runsPerMonth: 720,
            avgCostPerRun: null,
            p10CostPerRun: null,
            p90CostPerRun: null,
            monthlyEstimateUsd: null,
            monthlyLowUsd: null,
            monthlyHighUsd: null,
            insufficientHistory: true,
            cadenceUnresolved: false,
          },
          forecastLoading: false,
        }),
      ),
    );
    expect(html).toContain("Insufficient history");
    expect(html).toContain("720");
    expect(html).not.toContain("Estimated spend");
  });

  it("renders the unresolved hint when cadenceUnresolved=true", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({
          forecast: {
            sample: 3,
            runsPerMonth: 0,
            avgCostPerRun: 0.05,
            p10CostPerRun: 0.04,
            p90CostPerRun: 0.06,
            monthlyEstimateUsd: null,
            monthlyLowUsd: null,
            monthlyHighUsd: null,
            insufficientHistory: false,
            cadenceUnresolved: true,
          },
          forecastLoading: false,
        }),
      ),
    );
    expect(html).toContain("Forecast unavailable for this cadence");
  });

  it("uses singular 'sample' for sample === 1", () => {
    const html = renderToStaticMarkup(
      ScheduleCreateDialogView(
        baseProps({
          forecast: {
            sample: 1,
            runsPerMonth: 720,
            avgCostPerRun: 0.05,
            p10CostPerRun: 0.05,
            p90CostPerRun: 0.05,
            monthlyEstimateUsd: 36,
            monthlyLowUsd: 36,
            monthlyHighUsd: 36,
            insufficientHistory: false,
            cadenceUnresolved: false,
          },
          forecastLoading: false,
        }),
      ),
    );
    // Sample size 1 should still render as the dollar block — but the
    // helper marks it `insufficientHistory` ONLY if sample < 3. We
    // pass through `insufficientHistory: false` explicitly here to
    // pin the singular wording rule independent of the threshold.
    expect(html).toContain("1 sample");
    expect(html).not.toContain("1 samples");
  });
});
