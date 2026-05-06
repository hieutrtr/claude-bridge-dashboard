// P3-T7 — `<ScheduleRowActionsView>` smoke tests via
// `renderToStaticMarkup`. Same pattern as `<DangerConfirmView>` and
// `<LoopApprovalGateView>` — render the pure view across the state
// matrix and assert markup, attributes, disabled flags. The
// interactive `<ScheduleRowActions>` wrapper is exercised end-to-end
// by Playwright (`schedule-pause-delete.spec.ts`, Phase 3 step 11).

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ScheduleRowActionsView,
  type ScheduleRowActionsViewProps,
} from "../../src/components/schedule-row-actions";

function baseProps(
  overrides: Partial<ScheduleRowActionsViewProps> = {},
): ScheduleRowActionsViewProps {
  return {
    scheduleId: 42,
    scheduleName: "nightly-tests",
    enabled: true,
    status: "idle",
    errorCode: null,
    errorMessage: null,
    csrfMissing: false,
    ...overrides,
  };
}

describe("<ScheduleRowActionsView>", () => {
  it("renders Pause + Delete triggers when enabled=true", () => {
    const html = renderToStaticMarkup(ScheduleRowActionsView(baseProps()));
    expect(html).toContain('data-testid="schedule-pause-trigger"');
    expect(html).toContain('data-testid="schedule-delete-trigger"');
    // Pause label visible
    expect(html).toContain(">Pause<");
    // Delete label visible
    expect(html).toContain(">Delete<");
    // The Resume trigger is NOT rendered when enabled=true.
    expect(html).not.toContain('data-testid="schedule-resume-trigger"');
  });

  it("renders Resume + Delete triggers when enabled=false", () => {
    const html = renderToStaticMarkup(
      ScheduleRowActionsView(baseProps({ enabled: false })),
    );
    expect(html).toContain('data-testid="schedule-resume-trigger"');
    expect(html).toContain(">Resume<");
    expect(html).not.toContain('data-testid="schedule-pause-trigger"');
    // Delete is always present (regardless of enabled state).
    expect(html).toContain('data-testid="schedule-delete-trigger"');
  });

  it("flips icon glyph between active (⏸) and paused (▶) states", () => {
    const active = renderToStaticMarkup(
      ScheduleRowActionsView(baseProps({ enabled: true })),
    );
    expect(active).toContain("⏸");
    expect(active).not.toContain("▶");

    const paused = renderToStaticMarkup(
      ScheduleRowActionsView(baseProps({ enabled: false })),
    );
    expect(paused).toContain("▶");
    expect(paused).not.toContain("⏸");
  });

  it("disables both triggers while submitting", () => {
    const html = renderToStaticMarkup(
      ScheduleRowActionsView(baseProps({ status: "submitting" })),
    );
    // Both buttons get a `disabled` attribute when in-flight.
    const pauseRe = /<button[^>]*data-testid="schedule-pause-trigger"[^>]*disabled/;
    const deleteRe = /<button[^>]*data-testid="schedule-delete-trigger"[^>]*disabled/;
    expect(html).toMatch(pauseRe);
    expect(html).toMatch(deleteRe);
  });

  it("disables both triggers when csrfMissing=true (session expired)", () => {
    const html = renderToStaticMarkup(
      ScheduleRowActionsView(baseProps({ csrfMissing: true })),
    );
    const pauseRe = /<button[^>]*data-testid="schedule-pause-trigger"[^>]*disabled/;
    const deleteRe = /<button[^>]*data-testid="schedule-delete-trigger"[^>]*disabled/;
    expect(html).toMatch(pauseRe);
    expect(html).toMatch(deleteRe);
  });

  it("renders an error envelope inline when status='error'", () => {
    const html = renderToStaticMarkup(
      ScheduleRowActionsView(
        baseProps({
          status: "error",
          errorCode: "TOO_MANY_REQUESTS",
          errorMessage: "rate-limited — try again",
        }),
      ),
    );
    expect(html).toContain('data-testid="schedule-row-actions-error"');
    expect(html).toContain("TOO_MANY_REQUESTS");
    expect(html).toContain("rate-limited — try again");
  });

  it("does not render error envelope when status='idle'", () => {
    const html = renderToStaticMarkup(ScheduleRowActionsView(baseProps()));
    expect(html).not.toContain('data-testid="schedule-row-actions-error"');
  });

  it("aria-label exposes the schedule name for screen readers", () => {
    const html = renderToStaticMarkup(
      ScheduleRowActionsView(baseProps({ scheduleName: "very-special" })),
    );
    expect(html).toContain('aria-label="Actions for very-special"');
  });

  it("encodes schedule name into the Delete button's title attribute", () => {
    const html = renderToStaticMarkup(
      ScheduleRowActionsView(baseProps({ scheduleName: "my-schedule" })),
    );
    expect(html).toContain('title="Delete my-schedule"');
  });

  it("encodes schedule name into the Pause/Resume button's title attribute", () => {
    const active = renderToStaticMarkup(
      ScheduleRowActionsView(baseProps({ scheduleName: "x", enabled: true })),
    );
    expect(active).toContain('title="Pause x"');
    const paused = renderToStaticMarkup(
      ScheduleRowActionsView(baseProps({ scheduleName: "x", enabled: false })),
    );
    expect(paused).toContain('title="Resume x"');
  });

  it("data-state attribute on Pause/Resume reflects the enabled flag", () => {
    const active = renderToStaticMarkup(
      ScheduleRowActionsView(baseProps({ enabled: true })),
    );
    expect(active).toMatch(/data-state="active"/);
    const paused = renderToStaticMarkup(
      ScheduleRowActionsView(baseProps({ enabled: false })),
    );
    expect(paused).toMatch(/data-state="paused"/);
  });
});
