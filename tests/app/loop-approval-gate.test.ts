// P3-T4 — `<LoopApprovalGateView>` markup tests. Same pattern as
// `tests/app/danger-confirm.test.ts`: feed the React element into
// `renderToStaticMarkup` and assert the rendered HTML reflects the
// state matrix. The interactive `<LoopApprovalGate>` wrapper (state,
// fetch, cookie read) is exercised via the component test for
// `<LoopCancelButton>` + the Phase 3 Playwright sweep.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LoopApprovalGateView,
  type LoopApprovalGateViewProps,
} from "../../src/components/loop-approval-gate";

function baseProps(
  overrides: Partial<LoopApprovalGateViewProps> = {},
): LoopApprovalGateViewProps {
  return {
    status: "idle",
    reason: "",
    alreadyFinalized: false,
    errorCode: null,
    errorMessage: null,
    csrfMissing: false,
    ...overrides,
  };
}

describe("<LoopApprovalGateView> — idle", () => {
  it("renders Approve and Deny buttons (large, accessible labels)", () => {
    const html = renderToStaticMarkup(LoopApprovalGateView(baseProps()));
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
    expect(html).toContain("Awaiting your decision");
    expect(html).toContain('data-testid="loop-approve-button"');
    expect(html).toContain('data-testid="loop-deny-button"');
    // Phase 3 acceptance — Approve/Deny render large.
    expect(html).toContain("h-14");
  });

  it("disables both buttons when csrfMissing=true and surfaces a hint", () => {
    const html = renderToStaticMarkup(
      LoopApprovalGateView(baseProps({ csrfMissing: true })),
    );
    expect(html).toMatch(/session expired/i);
    const approve = html.match(
      /<button[^>]*data-testid="loop-approve-button"[^>]*>[\s\S]*?<\/button>/,
    );
    const deny = html.match(
      /<button[^>]*data-testid="loop-deny-button"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(approve).not.toBeNull();
    expect(deny).not.toBeNull();
    expect(approve![0]).toMatch(/\sdisabled(=|>|\s)/);
    expect(deny![0]).toMatch(/\sdisabled(=|>|\s)/);
  });
});

describe("<LoopApprovalGateView> — submitting", () => {
  it("renders Approving… while submitting-approve", () => {
    const html = renderToStaticMarkup(
      LoopApprovalGateView(baseProps({ status: "submitting-approve" })),
    );
    expect(html).toContain("Approving");
    const approve = html.match(
      /<button[^>]*data-testid="loop-approve-button"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(approve![0]).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("disables Confirm deny while submitting-reject", () => {
    const html = renderToStaticMarkup(
      LoopApprovalGateView(
        baseProps({ status: "submitting-reject", reason: "bad" }),
      ),
    );
    expect(html).toContain("Denying");
    const submit = html.match(
      /<button[^>]*data-testid="loop-deny-submit"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(submit).not.toBeNull();
    expect(submit![0]).toMatch(/\sdisabled(=|>|\s)/);
  });
});

describe("<LoopApprovalGateView> — denying mode", () => {
  it("shows the reason form, not the Approve/Deny pair, when status=denying", () => {
    const html = renderToStaticMarkup(
      LoopApprovalGateView(baseProps({ status: "denying" })),
    );
    expect(html).toContain('data-testid="loop-deny-form"');
    expect(html).toContain('data-testid="loop-deny-reason"');
    expect(html).toContain('data-testid="loop-deny-submit"');
    // Approve/Deny large pair is hidden.
    expect(html).not.toContain('data-testid="loop-approve-button"');
  });

  it("rejects (visually) reasons longer than 1000 chars", () => {
    const html = renderToStaticMarkup(
      LoopApprovalGateView(
        baseProps({
          status: "denying",
          reason: "x".repeat(1001),
        }),
      ),
    );
    expect(html).toMatch(/≤ 1000 characters/);
    const submit = html.match(
      /<button[^>]*data-testid="loop-deny-submit"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(submit![0]).toMatch(/\sdisabled(=|>|\s)/);
  });
});

describe("<LoopApprovalGateView> — resolved", () => {
  it("renders the resolved banner (alreadyFinalized:false → 'Decision recorded')", () => {
    const html = renderToStaticMarkup(
      LoopApprovalGateView(baseProps({ status: "resolved" })),
    );
    expect(html).toContain('data-testid="loop-approval-resolved"');
    expect(html).toContain("Decision recorded");
    expect(html).not.toContain("Awaiting your decision");
  });

  it("renders the alreadyFinalized banner when the daemon raced us", () => {
    const html = renderToStaticMarkup(
      LoopApprovalGateView(
        baseProps({ status: "resolved", alreadyFinalized: true }),
      ),
    );
    expect(html).toContain("Loop already finalized");
  });
});

describe("<LoopApprovalGateView> — error", () => {
  it("surfaces error code + message when status=error", () => {
    const html = renderToStaticMarkup(
      LoopApprovalGateView(
        baseProps({
          status: "error",
          errorCode: "TIMEOUT",
          errorMessage: "Daemon did not respond within timeout",
        }),
      ),
    );
    expect(html).toContain('data-testid="loop-approval-error"');
    expect(html).toContain("TIMEOUT");
    expect(html).toContain("Daemon did not respond");
  });

  it("falls back to a generic message when errorMessage missing", () => {
    const html = renderToStaticMarkup(
      LoopApprovalGateView(
        baseProps({
          status: "error",
          errorCode: "INTERNAL_SERVER_ERROR",
          errorMessage: null,
        }),
      ),
    );
    expect(html).toContain("request failed");
  });
});

describe("<LoopApprovalGateView> — privacy", () => {
  it("warns the user that reason text is not echoed into the audit log", () => {
    const html = renderToStaticMarkup(
      LoopApprovalGateView(baseProps({ status: "denying" })),
    );
    expect(html).toMatch(/NOT logged in[\s\S]*audit trail/);
  });
});
