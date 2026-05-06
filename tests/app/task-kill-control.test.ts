// P2-T10 — `<TaskKillControlView>` smoke tests. The view is the pure
// presentational core of `<TaskKillControl>` (the client island that
// owns the optimistic kill state). We exercise the optimistic state
// matrix here with `renderToStaticMarkup`; the interactive wrapper is
// covered by Playwright in step 14.
//
// Optimistic state lifecycle (encoded in this matrix):
//
//   serverStatus    optimistic    rendered badge    Kill button
//   ────────────    ──────────    ──────────────    ────────────
//   running         null          running           visible
//   running         "killing"     killing           hidden (in-flight)
//   running         "killed"      killed            hidden (final)
//   killed          null          killed            hidden (server says so)
//   running (after rollback, optimistic=null) — Kill button is back

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TaskKillControlView,
  type TaskKillControlViewProps,
} from "../../src/components/task-kill-control";

function baseProps(
  overrides: Partial<TaskKillControlViewProps> = {},
): TaskKillControlViewProps {
  return {
    taskId: 42,
    agentName: "alpha",
    serverStatus: "running",
    optimisticStatus: null,
    ...overrides,
  };
}

describe("<TaskKillControlView>", () => {
  it("renders the running badge + the Kill trigger when optimistic=null and server=running", () => {
    const html = renderToStaticMarkup(TaskKillControlView(baseProps()));
    // Badge label for `running` — taskStatusBadge maps `running` to
    // a label of `running`.
    expect(html.toLowerCase()).toContain("running");
    expect(html).toContain("Kill");
  });

  it("renders a 'Killing' indicator and hides the Kill button while optimistic='killing'", () => {
    const html = renderToStaticMarkup(
      TaskKillControlView(baseProps({ optimisticStatus: "killing" })),
    );
    expect(html.toLowerCase()).toContain("killing");
    // Button must be gone — clicking it again would re-fire the
    // mutation. The `<DangerConfirm>` tail (success/error dialog) is
    // rendered by the wrapper, not the view.
    expect(html).not.toMatch(/<button[^>]*>Kill<\/button>/);
  });

  it("renders the killed badge and hides the Kill button when optimistic='killed'", () => {
    const html = renderToStaticMarkup(
      TaskKillControlView(
        baseProps({ optimisticStatus: "killed", serverStatus: "running" }),
      ),
    );
    expect(html.toLowerCase()).toContain("killed");
    expect(html).not.toMatch(/<button[^>]*>Kill<\/button>/);
  });

  it("renders the killed badge and hides the Kill button when server already terminal", () => {
    const html = renderToStaticMarkup(
      TaskKillControlView(
        baseProps({ optimisticStatus: null, serverStatus: "killed" }),
      ),
    );
    expect(html.toLowerCase()).toContain("killed");
    expect(html).not.toMatch(/<button[^>]*>Kill<\/button>/);
  });

  it("after a rollback (optimistic returned to null), the Kill trigger reappears so the user can retry", () => {
    // Rollback contract — `<TaskKillControl>` resets `optimisticStatus`
    // to null on a fetcher rejection. Re-rendering the view with the
    // rolled-back state must produce a clickable Kill button again.
    const html = renderToStaticMarkup(
      TaskKillControlView(
        baseProps({ optimisticStatus: null, serverStatus: "running" }),
      ),
    );
    expect(html).toContain("Kill");
    expect(html.toLowerCase()).toContain("running");
  });

  it("orphan task (agentName=null) — no Kill button, badge still rendered", () => {
    const html = renderToStaticMarkup(
      TaskKillControlView(baseProps({ agentName: null })),
    );
    expect(html.toLowerCase()).toContain("running");
    expect(html).not.toMatch(/<button[^>]*>Kill<\/button>/);
  });
});
