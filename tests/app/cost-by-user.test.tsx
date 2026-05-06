// P4-T04 — `<CostByUser>` leaderboard render checks.
//
// Pure component (no Recharts measurement, no client state); we exercise
// every render branch via `renderToStaticMarkup` straight off the wire
// shape. Branches covered:
//   * owner empty
//   * owner populated (top-spender card + leaderboard rows + share %)
//   * owner with `(unattributed)` bucket
//   * member view (selfRow only, no top-spender card)
//   * member zero-fill (no rows but selfRow visible)

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CostByUser } from "../../src/components/cost-by-user";
import type { CostByUserPayload } from "../../src/server/dto";

function ownerPayload(
  override: Partial<CostByUserPayload> = {},
): CostByUserPayload {
  return {
    window: "30d",
    since: "2026-04-07 00:00:00",
    rows: [],
    totalCostUsd: 0,
    totalTasks: 0,
    callerRole: "owner",
    selfRow: null,
    ...override,
  };
}

function memberPayload(
  override: Partial<CostByUserPayload> = {},
): CostByUserPayload {
  return {
    window: "30d",
    since: "2026-04-07 00:00:00",
    rows: [],
    totalCostUsd: 0,
    totalTasks: 0,
    callerRole: "member",
    selfRow: {
      userId: "u-self",
      email: "self@example.com",
      costUsd: 0,
      taskCount: 0,
      shareOfTotal: 0,
    },
    ...override,
  };
}

describe("<CostByUser> owner branch", () => {
  it("renders the empty-state copy for zero rows", () => {
    const html = renderToStaticMarkup(
      <CostByUser payload={ownerPayload()} />,
    );
    expect(html).toContain("No completed tasks in this window");
    expect(html).not.toContain("Top spender");
  });

  it("renders the Top spender card when rows exist", () => {
    const html = renderToStaticMarkup(
      <CostByUser
        payload={ownerPayload({
          rows: [
            {
              userId: "u-bob",
              email: "bob@example.com",
              costUsd: 9.5,
              taskCount: 3,
              shareOfTotal: 0.95,
            },
            {
              userId: "u-alice",
              email: "alice@example.com",
              costUsd: 0.5,
              taskCount: 1,
              shareOfTotal: 0.05,
            },
          ],
          totalCostUsd: 10,
          totalTasks: 4,
        })}
      />,
    );
    expect(html).toContain("Top spender");
    expect(html).toContain("$9.50");
    expect(html).toContain("bob@example.com");
    expect(html).toContain("alice@example.com");
    // Share renders as a percent rounded to one decimal place.
    expect(html).toContain("95.0%");
    expect(html).toContain("5.0%");
  });

  it("renders (unattributed) italicised when email is null", () => {
    const html = renderToStaticMarkup(
      <CostByUser
        payload={ownerPayload({
          rows: [
            {
              userId: null,
              email: null,
              costUsd: 1,
              taskCount: 1,
              shareOfTotal: 1,
            },
          ],
          totalCostUsd: 1,
          totalTasks: 1,
        })}
      />,
    );
    expect(html).toContain("(unattributed)");
    expect(html).toMatch(/<span class="italic[^"]*">\(unattributed\)<\/span>/);
  });
});

describe("<CostByUser> member branch", () => {
  it("renders the self-only card without the leaderboard", () => {
    const html = renderToStaticMarkup(
      <CostByUser
        payload={memberPayload({
          rows: [
            {
              userId: "u-self",
              email: "self@example.com",
              costUsd: 2.5,
              taskCount: 4,
              shareOfTotal: 1,
            },
          ],
          totalCostUsd: 2.5,
          totalTasks: 4,
          selfRow: {
            userId: "u-self",
            email: "self@example.com",
            costUsd: 2.5,
            taskCount: 4,
            shareOfTotal: 1,
          },
        })}
      />,
    );
    expect(html).toContain("Your spend this window");
    expect(html).toContain("$2.50");
    expect(html).toContain("Owners can see the full per-user leaderboard");
    expect(html).not.toContain("Top spender");
    expect(html).not.toContain("Spend by user");
  });

  it("renders the zero-fill row when no spend in window", () => {
    const html = renderToStaticMarkup(
      <CostByUser payload={memberPayload()} />,
    );
    expect(html).toContain("Your spend this window");
    expect(html).toContain("$0.00");
    expect(html).toContain("0 tasks");
  });
});
