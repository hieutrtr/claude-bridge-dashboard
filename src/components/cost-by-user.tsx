// P4-T04 — leaderboard for the `/cost?tab=user` view.
//
// Pure render — no `useState` / `useEffect`, all state in props. Server-
// rendered from `app/cost/page.tsx`. Owners see every active user + the
// (unattributed) bucket; members see one row (their own, zero-filled
// when no spend in the window). The shape decision lives on the
// `analytics.costByUser` wire (`callerRole`, `selfRow`) so this leaf
// stays presentational.

import type { ReactElement } from "react";

import type { CostByUserPayload } from "@/src/server/dto";

interface CostByUserProps {
  payload: CostByUserPayload;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function emailLabel(email: string | null): ReactElement {
  if (email !== null) return <span>{email}</span>;
  return (
    <span className="italic text-[hsl(var(--muted-foreground))]">
      (unattributed)
    </span>
  );
}

export function CostByUser({ payload }: CostByUserProps) {
  const isOwner = payload.callerRole === "owner";
  const top = isOwner && payload.rows.length > 0 ? payload.rows[0]! : null;

  if (!isOwner) {
    return <MemberView payload={payload} />;
  }

  if (payload.rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[hsl(var(--border))] p-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
        No completed tasks in this window — once tasks land, the per-user
        leaderboard appears here.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {top !== null ? <TopSpenderCard row={top} /> : null}
      <Leaderboard payload={payload} />
    </div>
  );
}

function TopSpenderCard({
  row,
}: {
  row: CostByUserPayload["rows"][number];
}) {
  return (
    <section
      aria-label="Top spender"
      className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4"
    >
      <div className="text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
        Top spender
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4">
        <div className="text-2xl font-semibold tabular-nums">
          {fmtUsd(row.costUsd)}
        </div>
        <div className="text-sm">{emailLabel(row.email)}</div>
        <div className="text-xs text-[hsl(var(--muted-foreground))]">
          {row.taskCount} {row.taskCount === 1 ? "task" : "tasks"} ·{" "}
          {fmtPercent(row.shareOfTotal)} of spend
        </div>
      </div>
    </section>
  );
}

function Leaderboard({ payload }: { payload: CostByUserPayload }) {
  return (
    <section
      aria-label="Cost leaderboard"
      className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[hsl(var(--border))] px-4 py-3">
        <h2 className="text-sm font-medium">Spend by user</h2>
        <div className="text-xs text-[hsl(var(--muted-foreground))]">
          {payload.totalTasks} task{payload.totalTasks === 1 ? "" : "s"} ·{" "}
          {fmtUsd(payload.totalCostUsd)} total
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[hsl(var(--border))] text-left text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">User</th>
              <th className="px-4 py-2 text-right font-medium">Tasks</th>
              <th className="px-4 py-2 text-right font-medium">Total spend</th>
              <th className="px-4 py-2 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {payload.rows.map((row, idx) => (
              <tr
                key={`${row.userId ?? "unattributed"}`}
                className="border-b border-[hsl(var(--border))] last:border-b-0"
              >
                <td className="px-4 py-2 tabular-nums text-[hsl(var(--muted-foreground))]">
                  {idx + 1}
                </td>
                <td className="px-4 py-2">{emailLabel(row.email)}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {row.taskCount}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtUsd(row.costUsd)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtPercent(row.shareOfTotal)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MemberView({ payload }: { payload: CostByUserPayload }) {
  const row = payload.selfRow;
  if (!row) {
    return (
      <div className="rounded-lg border border-dashed border-[hsl(var(--border))] p-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
        No completed tasks in this window.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <section
        aria-label="Your spend this window"
        className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4"
      >
        <div className="text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
          Your spend this window
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-4">
          <div className="text-2xl font-semibold tabular-nums">
            {fmtUsd(row.costUsd)}
          </div>
          <div className="text-xs text-[hsl(var(--muted-foreground))]">
            {row.taskCount} {row.taskCount === 1 ? "task" : "tasks"}
          </div>
        </div>
      </section>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        Owners can see the full per-user leaderboard.
      </p>
    </div>
  );
}
