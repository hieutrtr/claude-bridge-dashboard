// P3-T2 — `/loops/[loopId]` detail page. Server component that
// resolves the dynamic `[loopId]` segment, fetches the loop +
// iteration history via the in-process tRPC `createCaller`, and
// renders the header card + cumulative-cost sparkline + per-iter
// timeline. 404s when the id is unknown.
//
// Read-only invariant for this iter: no mutations. The cancel
// button + approve / reject gate land in P3-T4 — they plug into
// the header card via a sibling client component.

import Link from "next/link";
import { notFound } from "next/navigation";

import { appRouter } from "@/src/server/routers/_app";
import { Badge } from "@/src/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/card";
import { CostSparkline } from "@/src/components/cost-sparkline";
import { LoopControls } from "@/src/components/loop-controls";
import { loopStatusBadge } from "@/src/lib/loop-status";
import type { LoopDetail, LoopIterationRow } from "@/src/server/dto";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ loopId: string }>;
}

const ITERATION_COLLAPSE_LINES = 6;

function formatCost(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toFixed(4)}`;
}

function formatBudget(total: number, cap: number | null): string {
  return `${formatCost(total)} / ${cap === null ? "—" : formatCost(cap)}`;
}

function formatDurationMs(startedAt: string, finishedAt: string | null): string {
  if (finishedAt === null) return "—";
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  const ms = end - start;
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function budgetPercent(total: number, cap: number | null): number | null {
  if (cap === null || cap <= 0) return null;
  return Math.min(100, (total / cap) * 100);
}

function iterPercent(current: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, (current / max) * 100);
}

export default async function LoopDetailPage({ params }: PageProps) {
  const { loopId: rawId } = await params;
  const loopId = decodeURIComponent(rawId).trim();
  if (loopId.length === 0 || loopId.length > 128) {
    notFound();
  }

  const caller = appRouter.createCaller({});
  const loop = await caller.loops.get({ loopId });
  if (loop === null) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <Header loop={loop} />
      <LoopControls
        loopId={loop.loopId}
        status={loop.status}
        pendingApproval={loop.pendingApproval}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-6">
          <SparklineCard loop={loop} />
          <TimelineCard loop={loop} />
        </div>
        <MetadataSidebar loop={loop} />
      </div>
    </div>
  );
}

function Header({ loop }: { loop: LoopDetail }) {
  const badge = loopStatusBadge(loop.status, loop.pendingApproval);
  const iterPct = iterPercent(loop.currentIteration, loop.maxIterations);
  const budgetPct = budgetPercent(loop.totalCostUsd, loop.maxCostUsd);

  return (
    <header className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            <Link href="/loops" className="hover:underline">
              Loops
            </Link>
            {" / "}
            <span className="font-mono">{loop.loopId}</span>
          </div>
          <h1 className="text-2xl font-semibold">
            <Link
              href={`/agents/${encodeURIComponent(loop.agent)}`}
              className="hover:underline"
            >
              {loop.agent}
            </Link>{" "}
            <span className="font-mono text-[hsl(var(--muted-foreground))] text-base">
              · {loop.loopType}
            </span>
          </h1>
        </div>
        <Badge variant={badge.variant} data-testid="loop-status-badge">
          {badge.label}
        </Badge>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
              Goal
            </div>
            <p
              className="mt-1 whitespace-pre-wrap break-words text-sm"
              data-testid="loop-goal"
            >
              {loop.goal}
            </p>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <span>
              <span className="text-[hsl(var(--muted-foreground))]">Done when</span>{" "}
              <code className="font-mono">{loop.doneWhen}</code>
            </span>
            <span>
              <span className="text-[hsl(var(--muted-foreground))]">Plan</span>{" "}
              <span className="font-mono">{loop.planEnabled ? "enabled" : "disabled"}</span>
            </span>
            <span>
              <span className="text-[hsl(var(--muted-foreground))]">Pass threshold</span>{" "}
              <span className="font-mono">{loop.passThreshold}</span>
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <ProgressRow
              label={`Iteration ${loop.currentIteration} / ${loop.maxIterations}`}
              percent={iterPct}
              testid="iter-progress"
            />
            <ProgressRow
              label={`Budget ${formatBudget(loop.totalCostUsd, loop.maxCostUsd)}`}
              percent={budgetPct}
              testid="budget-progress"
            />
          </div>
        </CardContent>
      </Card>
    </header>
  );
}

function ProgressRow({
  label,
  percent,
  testid,
}: {
  label: string;
  percent: number | null;
  testid: string;
}) {
  return (
    <div data-testid={testid}>
      <div className="mb-1 text-xs text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-[hsl(var(--muted))]">
        {percent !== null && (
          <div
            className="h-full bg-emerald-500/70"
            style={{ width: `${percent.toFixed(1)}%` }}
          />
        )}
        {percent === null && (
          <div className="h-full bg-[hsl(var(--border))]" style={{ width: "0%" }} />
        )}
      </div>
    </div>
  );
}

function SparklineCard({ loop }: { loop: LoopDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cumulative cost</CardTitle>
      </CardHeader>
      <CardContent>
        <CostSparkline
          iterations={loop.iterations}
          totalCostUsd={loop.totalCostUsd}
          maxCostUsd={loop.maxCostUsd}
        />
      </CardContent>
    </Card>
  );
}

function TimelineCard({ loop }: { loop: LoopDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Iterations
          <span className="ml-2 text-xs font-normal text-[hsl(var(--muted-foreground))]">
            {loop.iterations.length} of {loop.totalIterations}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loop.iterationsTruncated && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Showing the most recent {loop.iterations.length} of{" "}
            {loop.totalIterations} iterations. Older iterations trimmed to keep
            the page responsive.
          </p>
        )}
        {loop.iterations.length === 0 ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            No iterations recorded yet — the daemon writes a row to{" "}
            <code className="font-mono">loop_iterations</code> as each step
            starts.
          </p>
        ) : (
          <ol className="space-y-2" data-testid="iteration-list">
            {loop.iterations.map((iter) => (
              <li key={iter.id}>
                <IterationRow iter={iter} />
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function IterationRow({ iter }: { iter: LoopIterationRow }) {
  const status = iter.status;
  const variant = (() => {
    if (iter.doneCheckPassed) return "running" as const;
    if (status === "running" || status === "pending") return "idle" as const;
    if (status === "failed" || status === "error") return "error" as const;
    return "idle" as const;
  })();
  const promptLines = iter.prompt?.split("\n") ?? [];
  const summaryLines = iter.resultSummary?.split("\n") ?? [];
  const isLong =
    promptLines.length > ITERATION_COLLAPSE_LINES ||
    summaryLines.length > ITERATION_COLLAPSE_LINES;

  return (
    <details
      className="group rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]"
      data-testid="iteration-row"
    >
      <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
        <span className="font-mono text-xs text-[hsl(var(--muted-foreground))]">
          #{iter.iterationNum}
        </span>
        <Badge variant={variant}>
          {iter.doneCheckPassed ? "passed" : status}
        </Badge>
        <span className="ml-auto flex items-center gap-3 text-xs text-[hsl(var(--muted-foreground))]">
          <span className="font-mono">{formatCost(iter.costUsd)}</span>
          <span className="font-mono">
            {formatDurationMs(iter.startedAt, iter.finishedAt)}
          </span>
          {iter.taskId !== null && (
            <Link
              href={`/tasks/${encodeURIComponent(iter.taskId)}`}
              className="hover:underline"
            >
              task →
            </Link>
          )}
        </span>
      </summary>
      <div className="space-y-3 border-t border-[hsl(var(--border))] px-3 py-3 text-xs">
        {iter.prompt && (
          <Section label="Prompt" body={iter.prompt} truncated={isLong} />
        )}
        {iter.resultSummary && (
          <Section
            label="Result summary"
            body={iter.resultSummary}
            truncated={isLong}
          />
        )}
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1 font-mono">
          <dt className="text-[hsl(var(--muted-foreground))]">Started</dt>
          <dd className="break-all">{iter.startedAt}</dd>
          <dt className="text-[hsl(var(--muted-foreground))]">Finished</dt>
          <dd className="break-all">{iter.finishedAt ?? "—"}</dd>
          <dt className="text-[hsl(var(--muted-foreground))]">Done check</dt>
          <dd>{iter.doneCheckPassed ? "passed" : "not yet"}</dd>
        </dl>
      </div>
    </details>
  );
}

function Section({
  label,
  body,
  truncated,
}: {
  label: string;
  body: string;
  truncated: boolean;
}) {
  return (
    <div>
      <div className="mb-1 text-[hsl(var(--muted-foreground))]">{label}</div>
      <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[hsl(var(--muted))] p-2 font-mono text-xs">
        {body}
      </pre>
      {truncated && (
        <p className="mt-1 text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
          Long body — scroll within the box
        </p>
      )}
    </div>
  );
}

function MetadataSidebar({ loop }: { loop: LoopDetail }) {
  const rows: Array<[string, string]> = [
    ["Status", loop.status],
    ["Type", loop.loopType],
    ["Channel", loop.channel ?? "—"],
    ["Channel chat", loop.channelChatId ?? "—"],
    ["Project", loop.project],
    ["Started", loop.startedAt],
    ["Finished", loop.finishedAt ?? "—"],
    ["Finish reason", loop.finishReason ?? "—"],
    ["Current task", loop.currentTaskId ?? "—"],
    ["Consec. passes", String(loop.consecutivePasses)],
    ["Consec. failures", String(loop.consecutiveFailures)],
  ];

  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle>Metadata</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
              <dt className="text-[hsl(var(--muted-foreground))]">{label}</dt>
              <dd className="break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
