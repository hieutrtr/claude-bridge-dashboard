// P2-T11 — `<DangerConfirmView>` view-only markup tests. Same pattern
// as `tests/app/dispatch-dialog.test.ts`: feed a React element into
// `renderToStaticMarkup` and assert the rendered HTML reflects the
// state.
//
// The interactive `<DangerConfirm>` wrapper (state, fetch, cookie read)
// is exercised by Playwright in the Phase 2 step 14 sweep. The view
// here is a pure function of its props — the props matrix below is
// what every consumer eventually sees.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DangerConfirmView,
  type DangerConfirmViewProps,
} from "../../src/components/danger-confirm";

function baseProps(
  overrides: Partial<DangerConfirmViewProps> = {},
): DangerConfirmViewProps {
  return {
    open: true,
    status: "idle",
    verb: "Kill",
    subject: "task #42 on agent alpha",
    expectedConfirmation: "alpha",
    typed: "",
    alreadyTerminated: false,
    errorCode: null,
    errorMessage: null,
    csrfMissing: false,
    ...overrides,
  };
}

describe("<DangerConfirmView>", () => {
  it("renders nothing observable when open=false", () => {
    const html = renderToStaticMarkup(
      DangerConfirmView(baseProps({ open: false })),
    );
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Kill task");
    expect(html).not.toContain("alpha");
  });

  it("renders the verb in the heading and the subject line when open", () => {
    const html = renderToStaticMarkup(DangerConfirmView(baseProps()));
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Kill");
    expect(html).toContain("task #42 on agent alpha");
  });

  it("disables the action button when typed value does not match", () => {
    const html = renderToStaticMarkup(
      DangerConfirmView(baseProps({ typed: "" })),
    );
    // Action button = the one whose text equals the verb.
    const action = html.match(
      /<button[^>]*data-role="confirm-action"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(action).not.toBeNull();
    expect(action![0]).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("enables the action button when typed value matches", () => {
    const html = renderToStaticMarkup(
      DangerConfirmView(baseProps({ typed: "alpha" })),
    );
    const action = html.match(
      /<button[^>]*data-role="confirm-action"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(action).not.toBeNull();
    expect(action![0]).not.toMatch(/\sdisabled(=|>|\s)/);
  });

  it("disables the action button while submitting, even on a match", () => {
    const html = renderToStaticMarkup(
      DangerConfirmView(
        baseProps({ typed: "alpha", status: "submitting" }),
      ),
    );
    const action = html.match(
      /<button[^>]*data-role="confirm-action"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(action).not.toBeNull();
    expect(action![0]).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("renders the session-expired hint and disables submit when csrfMissing=true", () => {
    const html = renderToStaticMarkup(
      DangerConfirmView(
        baseProps({ typed: "alpha", csrfMissing: true }),
      ),
    );
    expect(html).toContain("session expired");
    const action = html.match(
      /<button[^>]*data-role="confirm-action"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(action).not.toBeNull();
    expect(action![0]).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("renders the success copy and a Close button on status=success", () => {
    const html = renderToStaticMarkup(
      DangerConfirmView(baseProps({ status: "success" })),
    );
    expect(html).toContain("Killed");
    // The form should be gone in the success branch.
    expect(html).not.toMatch(/<input[^>]*data-role="confirm-input"/);
    // A close button is present.
    expect(html).toContain("Close");
  });

  it("mentions 'already terminated' on success when the daemon raced", () => {
    const html = renderToStaticMarkup(
      DangerConfirmView(
        baseProps({ status: "success", alreadyTerminated: true }),
      ),
    );
    expect(html).toContain("already terminated");
  });

  it("renders the error code + message on status=error and keeps the form", () => {
    const html = renderToStaticMarkup(
      DangerConfirmView(
        baseProps({
          status: "error",
          typed: "alpha",
          errorCode: "TIMEOUT",
          errorMessage: "Daemon did not respond within timeout",
        }),
      ),
    );
    expect(html).toContain("TIMEOUT");
    expect(html).toContain("Daemon did not respond within timeout");
    // Form still rendered so the user can retry.
    expect(html).toContain('data-role="confirm-input"');
  });

  it("always renders a Cancel button alongside the action in the form variant", () => {
    const html = renderToStaticMarkup(DangerConfirmView(baseProps()));
    expect(html).toContain("Cancel");
  });

  it("includes the confirmation input bound to the typed prop", () => {
    const html = renderToStaticMarkup(
      DangerConfirmView(baseProps({ typed: "al" })),
    );
    const input = html.match(/<input[^>]*data-role="confirm-input"[^>]*>/);
    expect(input).not.toBeNull();
    expect(input![0]).toContain('value="al"');
  });
});
