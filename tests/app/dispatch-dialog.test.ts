// P2-T02 — `<DispatchDialogView>` view-only markup tests. Mirrors the
// pattern used by the page-level smoke tests in `tests/app/`: feed a
// React element into `renderToStaticMarkup` and assert the rendered
// HTML contains the right copy and form controls.
//
// The interactive `<DispatchDialog>` wrapper is *not* exercised here —
// `useState`, `useEffect`, and the global `keydown` listener can only
// run with a DOM, which the repo's bun test config does not provide.
// Playwright (Phase 2 step 14) drives the full ⌘K → submit flow.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DispatchDialogView,
  type DispatchDialogViewProps,
} from "../../src/components/dispatch-dialog";
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

function baseProps(overrides: Partial<DispatchDialogViewProps> = {}): DispatchDialogViewProps {
  return {
    open: true,
    status: "idle",
    agents: AGENTS_FIXTURE,
    agentName: "alpha",
    prompt: "",
    model: "",
    completedTaskId: null,
    errorCode: null,
    errorMessage: null,
    csrfMissing: false,
    ...overrides,
  };
}

describe("<DispatchDialogView>", () => {
  it("renders nothing observable when open=false", () => {
    const html = renderToStaticMarkup(
      DispatchDialogView(baseProps({ open: false })),
    );
    // We don't assert exact emptiness because Tailwind utility classes
    // may live on a hidden wrapper; we assert the dialog role is gone
    // and the agent option strings are not present.
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Dispatch task");
    expect(html).not.toContain("alpha");
    expect(html).not.toContain("beta");
  });

  it("renders a loading placeholder when status='loading'", () => {
    const html = renderToStaticMarkup(
      DispatchDialogView(baseProps({ status: "loading", agents: [] })),
    );
    expect(html).toContain("Loading agents");
    // Until the agents arrive there's no select — no `<option>`.
    expect(html).not.toMatch(/<option/);
  });

  it("renders agent options + prompt textarea + dispatch button when idle", () => {
    const html = renderToStaticMarkup(
      DispatchDialogView(baseProps({ prompt: "hi" })),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Dispatch task");
    // Agent select with one option per fixture row.
    expect(html).toContain('name="agentName"');
    expect(html).toContain(">alpha<");
    expect(html).toContain(">beta<");
    // Prompt textarea.
    expect(html).toContain('name="prompt"');
    // Submit button enabled.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>/);
    // No `disabled=""` attribute on the submit button (idle state). We
    // search for the attribute form, not the substring, because the
    // Tailwind classes include `disabled:opacity-50`.
    const submitMatch = html.match(/<button[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/);
    expect(submitMatch).not.toBeNull();
    expect(submitMatch![0]).not.toMatch(/\sdisabled(=|>|\s)/);
  });

  it("disables the submit button while submitting", () => {
    const html = renderToStaticMarkup(
      DispatchDialogView(baseProps({ status: "submitting", prompt: "hi" })),
    );
    const submitMatch = html.match(/<button[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/);
    expect(submitMatch).not.toBeNull();
    expect(submitMatch![0]).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("renders a Task #N link on success", () => {
    const html = renderToStaticMarkup(
      DispatchDialogView(
        baseProps({ status: "success", completedTaskId: 42 }),
      ),
    );
    expect(html).toContain("/tasks/42");
    expect(html).toContain("Task #42");
  });

  it("renders the typed error code + message on error", () => {
    const html = renderToStaticMarkup(
      DispatchDialogView(
        baseProps({
          status: "error",
          prompt: "hi",
          errorCode: "TIMEOUT",
          errorMessage: "Daemon did not respond within timeout",
        }),
      ),
    );
    expect(html).toContain("TIMEOUT");
    expect(html).toContain("Daemon did not respond within timeout");
    // Submit button is re-enabled so the user can retry.
    const submitMatch = html.match(/<button[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/);
    expect(submitMatch).not.toBeNull();
    expect(submitMatch![0]).not.toMatch(/\sdisabled(=|>|\s)/);
  });

  it("renders a no-agents hint when the agents list is empty post-load", () => {
    const html = renderToStaticMarkup(
      DispatchDialogView(baseProps({ status: "idle", agents: [] })),
    );
    expect(html).toContain("No agents available");
    // No agent select shown.
    expect(html).not.toContain('name="agentName"');
  });

  it("disables submit and shows a session hint when csrfMissing=true", () => {
    const html = renderToStaticMarkup(
      DispatchDialogView(baseProps({ csrfMissing: true, prompt: "hi" })),
    );
    expect(html).toContain("session expired");
    const submitMatch = html.match(/<button[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/);
    expect(submitMatch).not.toBeNull();
    expect(submitMatch![0]).toMatch(/\sdisabled(=|>|\s)/);
  });

  it("disables submit when prompt is empty even in idle state", () => {
    const html = renderToStaticMarkup(
      DispatchDialogView(baseProps({ status: "idle", prompt: "" })),
    );
    const submitMatch = html.match(/<button[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/);
    expect(submitMatch).not.toBeNull();
    expect(submitMatch![0]).toMatch(/\sdisabled(=|>|\s)/);
  });
});
