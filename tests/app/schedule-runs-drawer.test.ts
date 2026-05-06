// P3-T8 — `<ScheduleRunsDrawerView>` smoke tests via
// `renderToStaticMarkup`. Same pattern as
// `<ScheduleRowActionsView>` (P3-T7) — render the pure view across
// the full state matrix and assert markup, badges, and link targets.
// The interactive `<ScheduleRunsDrawer>` wrapper (window event +
// fetch) is exercised at the integration level via the schedules
// page test; SPA-click coverage stays deferred per Phase 2 §5.

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  OPEN_SCHEDULE_RUNS_EVENT,
  ScheduleRunsDrawerView,
  ScheduleRunsTrigger,
  type ScheduleRunsDrawerViewProps,
} from "../../src/components/schedule-runs-drawer";
import type { ScheduleRunRow } from "../../src/server/dto";

function baseProps(
  overrides: Partial<ScheduleRunsDrawerViewProps> = {},
): ScheduleRunsDrawerViewProps {
  return {
    open: true,
    status: "ready",
    scheduleName: "nightly-tests",
    agentName: "alpha",
    items: [],
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

const SAMPLE_RUNS: ScheduleRunRow[] = [
  {
    id: 101,
    status: "done",
    costUsd: 0.123,
    durationMs: 1500,
    channel: "cli",
    createdAt: "2026-05-06T00:00:00.000Z",
    completedAt: "2026-05-06T00:00:30.000Z",
  },
  {
    id: 100,
    status: "failed",
    costUsd: 0.05,
    durationMs: 800,
    channel: "cli",
    createdAt: "2026-05-05T00:00:00.000Z",
    completedAt: null,
  },
];

describe("<ScheduleRunsDrawerView> — visibility", () => {
  it("renders nothing when open=false", () => {
    const html = renderToStaticMarkup(
      ScheduleRunsDrawerView(baseProps({ open: false })),
    );
    expect(html).toBe("");
  });

  it("renders the drawer skeleton when open=true", () => {
    const html = renderToStaticMarkup(ScheduleRunsDrawerView(baseProps()));
    expect(html).toContain('data-testid="schedule-runs-drawer"');
    expect(html).toContain('id="schedule-runs-drawer-title"');
    // Header carries the schedule name + agent.
    expect(html).toContain("Runs · nightly-tests");
    expect(html).toContain("alpha");
  });

  it("renders aria-modal=true and dialog role for accessibility", () => {
    const html = renderToStaticMarkup(ScheduleRunsDrawerView(baseProps()));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });
});

describe("<ScheduleRunsDrawerView> — state matrix", () => {
  it("loading state renders the loading sentinel", () => {
    const html = renderToStaticMarkup(
      ScheduleRunsDrawerView(baseProps({ status: "loading" })),
    );
    expect(html).toContain('data-testid="schedule-runs-loading"');
    expect(html).toContain("Loading runs");
  });

  it("empty state renders empty-copy + no list", () => {
    const html = renderToStaticMarkup(
      ScheduleRunsDrawerView(baseProps({ status: "empty" })),
    );
    expect(html).toContain('data-testid="schedule-runs-empty"');
    expect(html).toContain("No runs yet");
    expect(html).not.toContain('data-testid="schedule-runs-list"');
  });

  it("error state renders error code + message + close button", () => {
    const html = renderToStaticMarkup(
      ScheduleRunsDrawerView(
        baseProps({
          status: "error",
          errorCode: "INTERNAL_SERVER_ERROR",
          errorMessage: "daemon down",
        }),
      ),
    );
    expect(html).toContain('data-testid="schedule-runs-error"');
    expect(html).toContain("INTERNAL_SERVER_ERROR");
    expect(html).toContain("daemon down");
  });

  it("ready state renders one row per item with status badge + cost + duration + link to /tasks/[id]", () => {
    const html = renderToStaticMarkup(
      ScheduleRunsDrawerView(baseProps({ items: SAMPLE_RUNS })),
    );
    expect(html).toContain('data-testid="schedule-runs-list"');

    // Both rows present, ordered as supplied (most-recent first).
    const idx101 = html.indexOf("#101");
    const idx100 = html.indexOf("#100");
    expect(idx101).toBeGreaterThan(-1);
    expect(idx100).toBeGreaterThan(idx101);

    // Per-run links to /tasks/[id] (not /loops/[id]).
    expect(html).toContain('href="/tasks/101"');
    expect(html).toContain('href="/tasks/100"');

    // Status badges present (Done, Failed).
    expect(html).toContain(">Done<");
    expect(html).toContain(">Failed<");

    // Cost rendered with a $ + 4 decimals.
    expect(html).toContain("$0.1230");
    expect(html).toContain("$0.0500");

    // Duration rendered (1500ms → 1.5s; 800ms → 800ms).
    expect(html).toContain("1.5s");
    expect(html).toContain("800ms");
  });

  it("renders timestamps verbatim in monospace", () => {
    const html = renderToStaticMarkup(
      ScheduleRunsDrawerView(baseProps({ items: SAMPLE_RUNS })),
    );
    expect(html).toContain("2026-05-06T00:00:00.000Z");
  });

  it("falls back to em-dash for null cost / duration / timestamp", () => {
    const items: ScheduleRunRow[] = [
      {
        id: 7,
        status: "running",
        costUsd: null,
        durationMs: null,
        channel: "cli",
        createdAt: null,
        completedAt: null,
      },
    ];
    const html = renderToStaticMarkup(
      ScheduleRunsDrawerView(baseProps({ items })),
    );
    expect(html).toContain("#7");
    // Em-dash fallback for null values.
    expect(html).toContain("—");
  });

  it("falls back to 'schedule' label when scheduleName not yet known", () => {
    const html = renderToStaticMarkup(
      ScheduleRunsDrawerView(baseProps({ scheduleName: null })),
    );
    expect(html).toContain("Runs · schedule");
  });

  it("does not render the Agent sub-line when agentName=null", () => {
    const html = renderToStaticMarkup(
      ScheduleRunsDrawerView(baseProps({ agentName: null })),
    );
    expect(html).not.toContain("Agent:");
  });
});

describe("<ScheduleRunsTrigger>", () => {
  it("renders a button with the testid + a tooltip naming the schedule", () => {
    const html = renderToStaticMarkup(
      ScheduleRunsTrigger({ scheduleId: 42, scheduleName: "nightly-tests" }),
    );
    expect(html).toContain('data-testid="schedule-runs-trigger"');
    expect(html).toContain('title="View runs for nightly-tests"');
    expect(html).toContain(">Runs<");
  });
});

describe("OPEN_SCHEDULE_RUNS_EVENT — wire constant", () => {
  it("is namespaced to bridge:open-schedule-runs", () => {
    // Pinned because the trigger and the drawer both depend on the
    // exact string — divergence would silently break the open-event
    // pathway.
    expect(OPEN_SCHEDULE_RUNS_EVENT).toBe("bridge:open-schedule-runs");
  });
});
