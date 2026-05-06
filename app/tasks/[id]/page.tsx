// T06 — task detail page. Server component that resolves the dynamic
// `[id]` segment, fetches the task via the in-process tRPC `createCaller`,
// and renders header / prompt / result-markdown / metadata sidebar. 404s
// when the id is non-numeric, ≤ 0, or unknown.
//
// Read-only invariant (Phase 1): no `<form action method="post">`, no
// Server Action, no mutation procedure call.

import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";

import { appRouter } from "@/src/server/routers/_app";
import { taskStatusBadge } from "@/src/lib/task-status";
import { MARKDOWN_REHYPE_PLUGINS } from "@/src/lib/markdown";
import type { TranscriptTurn } from "@/src/lib/transcript";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/card";
import { KillTaskButton } from "@/src/components/kill-task-button";
import type { TaskDetail, TaskTranscript } from "@/src/server/dto";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

const PROMPT_COLLAPSE_LINES = 12;

function readId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function formatCost(cost: number | null): string {
  return cost === null ? "—" : `$${cost.toFixed(4)}`;
}

function formatDuration(ms: number | null): string {
  return ms === null ? "—" : `${ms}ms`;
}

export default async function TaskDetailPage({ params }: PageProps) {
  const { id: rawId } = await params;
  const id = readId(rawId);
  if (id === null) {
    notFound();
  }

  const caller = appRouter.createCaller({});
  const task = await caller.tasks.get({ id });
  if (!task) {
    notFound();
  }
  const transcript = await caller.tasks.transcript({ id });

  const badge = taskStatusBadge(task.status);

  return (
    <div className="space-y-6">
      <TaskHeader task={task} badge={badge} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-6">
          <PromptSection prompt={task.prompt} />
          <ResultSection task={task} />
          {transcript && <TranscriptSection transcript={transcript} />}
        </div>
        <MetadataSidebar task={task} />
      </div>
    </div>
  );
}

function TaskHeader({
  task,
  badge,
}: {
  task: TaskDetail;
  badge: { label: string; variant: "running" | "idle" | "error" | "unknown" };
}) {
  return (
    <header className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            Task
          </div>
          <h1 className="font-mono text-2xl font-semibold">#{task.id}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          <KillTaskButton
            taskId={task.id}
            agentName={task.agentName ?? null}
            status={task.status ?? null}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[hsl(var(--muted-foreground))]">
        <span>
          Agent:{" "}
          {task.agentName ? (
            <Link
              href={`/agents/${encodeURIComponent(task.agentName)}`}
              className="font-mono text-[hsl(var(--foreground))] hover:underline"
            >
              {task.agentName}
            </Link>
          ) : (
            <span className="font-mono">—</span>
          )}
        </span>
        <span>
          Cost: <span className="font-mono">{formatCost(task.costUsd)}</span>
        </span>
        <span>
          Duration:{" "}
          <span className="font-mono">{formatDuration(task.durationMs)}</span>
        </span>
        <span>
          Channel: <span className="font-mono">{task.channel ?? "—"}</span>
        </span>
        <span>
          Created: <span className="font-mono">{task.createdAt ?? "—"}</span>
        </span>
      </div>
    </header>
  );
}

function PromptSection({ prompt }: { prompt: string }) {
  const lines = prompt.split("\n");
  const isLong = lines.length > PROMPT_COLLAPSE_LINES;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Prompt</CardTitle>
      </CardHeader>
      <CardContent>
        {isLong ? (
          <details>
            <summary className="cursor-pointer text-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
              Show full prompt ({lines.length} lines)
            </summary>
            <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[hsl(var(--muted))] p-3 font-mono text-xs">
              {prompt}
            </pre>
          </details>
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-[hsl(var(--muted))] p-3 font-mono text-xs">
            {prompt}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function ResultSection({ task }: { task: TaskDetail }) {
  const md = task.resultMarkdown;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Result</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {task.resultMarkdownTruncated && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Result truncated to 500 KB. The agent produced a longer summary —
            inspect the raw transcript (T07) for the full output.
          </p>
        )}
        {md && md.length > 0 ? (
          <div className="markdown-body break-words text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-[hsl(var(--muted))] [&_code]:px-1 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-[hsl(var(--muted))] [&_pre]:p-3">
            <ReactMarkdown rehypePlugins={MARKDOWN_REHYPE_PLUGINS}>
              {md}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            No result yet. <code className="font-mono">result_summary</code>{" "}
            populates when the daemon finishes the task.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function TranscriptSection({ transcript }: { transcript: TaskTranscript }) {
  const banners: React.ReactElement[] = [];
  if (transcript.fileMissing) {
    banners.push(
      <p
        key="missing"
        className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]"
      >
        No transcript on disk. The session file may live on a different host
        or has been deleted.{" "}
        <code className="font-mono break-all">{transcript.filePath}</code>
      </p>,
    );
  }
  if (transcript.fileTooLarge) {
    banners.push(
      <p
        key="too-large"
        className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
      >
        Transcript file is{" "}
        {(transcript.fileBytes / (1024 * 1024)).toFixed(1)} MB — too large to
        render. Open{" "}
        <code className="font-mono break-all">{transcript.filePath}</code>{" "}
        directly.
      </p>,
    );
  }
  if (transcript.truncated) {
    banners.push(
      <p
        key="truncated"
        className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
      >
        Showing the most recent {transcript.turns.length} of{" "}
        {transcript.totalLines} turns. Older turns trimmed to keep the page
        responsive.
      </p>,
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Transcript</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {banners}
        {transcript.turns.length === 0 && !transcript.fileMissing &&
          !transcript.fileTooLarge && (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              The session JSONL has no parseable turns yet.
            </p>
          )}
        {transcript.turns.length > 0 && (
          <ol className="space-y-2">
            {transcript.turns.map((turn, idx) => (
              <li key={idx}>
                <TranscriptTurnView turn={turn} />
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function TranscriptTurnView({ turn }: { turn: TranscriptTurn }) {
  switch (turn.kind) {
    case "user":
      return (
        <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 py-2 text-sm">
          <div className="mb-1 text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            User
            {turn.timestamp && (
              <span className="ml-2 font-mono">{turn.timestamp}</span>
            )}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">
            {turn.text}
          </pre>
          {turn.truncated && <TruncatedHint />}
        </div>
      );
    case "user_tool_result":
      return (
        <div className="rounded-md border border-[hsl(var(--border))] px-3 py-2 text-xs">
          <div className="mb-1 flex items-center gap-2 text-[hsl(var(--muted-foreground))]">
            <span className="uppercase tracking-wide">Tool result</span>
            <code className="font-mono">{turn.toolUseId}</code>
          </div>
          <details>
            <summary className="cursor-pointer text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
              Show body ({turn.content.length} chars)
            </summary>
            <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[hsl(var(--muted))] p-2 font-mono">
              {turn.content}
            </pre>
          </details>
          {turn.truncated && <TruncatedHint />}
        </div>
      );
    case "assistant_text":
      return (
        <div className="rounded-md border border-[hsl(var(--border))] px-3 py-2 text-sm">
          <div className="mb-1 text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            Assistant
            {turn.model && (
              <span className="ml-2 font-mono">{turn.model}</span>
            )}
            {turn.timestamp && (
              <span className="ml-2 font-mono">{turn.timestamp}</span>
            )}
          </div>
          <div className="markdown-body break-words text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-[hsl(var(--muted))] [&_code]:px-1 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-[hsl(var(--muted))] [&_pre]:p-3">
            <ReactMarkdown rehypePlugins={MARKDOWN_REHYPE_PLUGINS}>
              {turn.text}
            </ReactMarkdown>
          </div>
          {turn.truncated && <TruncatedHint />}
        </div>
      );
    case "assistant_thinking":
      return (
        <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 py-2 text-xs italic">
          <div className="mb-1 uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            Thinking
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono">
            {turn.text || "(empty)"}
          </pre>
          {turn.truncated && <TruncatedHint />}
        </div>
      );
    case "assistant_tool_use": {
      const preview = turn.inputJson.length > 200
        ? turn.inputJson.slice(0, 200) + "…"
        : turn.inputJson;
      return (
        <div className="rounded-md border border-[hsl(var(--border))] px-3 py-2 text-xs">
          <div className="font-mono">
            <span className="text-[hsl(var(--muted-foreground))]">→</span>{" "}
            <span className="font-semibold">{turn.toolName}</span>
            <span className="text-[hsl(var(--muted-foreground))]">(</span>
            <span className="break-all">{preview}</span>
            <span className="text-[hsl(var(--muted-foreground))]">)</span>
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
              Show full input · <code>{turn.toolUseId}</code>
            </summary>
            <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[hsl(var(--muted))] p-2 font-mono">
              {turn.inputJson}
            </pre>
          </details>
        </div>
      );
    }
    case "system":
      return (
        <div className="rounded-md border border-[hsl(var(--border))] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">
          <div className="mb-1 uppercase tracking-wide">System</div>
          <pre className="whitespace-pre-wrap break-words font-mono">
            {turn.text}
          </pre>
          {turn.truncated && <TruncatedHint />}
        </div>
      );
    case "meta":
      return (
        <details className="rounded-md border border-dashed border-[hsl(var(--border))] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">
          <summary className="cursor-pointer hover:text-[hsl(var(--foreground))]">
            <span className="uppercase tracking-wide">Meta</span>{" "}
            <code className="font-mono">{turn.type}</code>
          </summary>
          <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[hsl(var(--muted))] p-2 font-mono">
            {turn.rawJson}
          </pre>
        </details>
      );
    case "raw":
      return (
        <details className="rounded-md border border-dashed border-red-500/40 px-3 py-2 text-xs text-red-300">
          <summary className="cursor-pointer">
            <span className="uppercase tracking-wide">Unparseable line</span>
          </summary>
          <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[hsl(var(--muted))] p-2 font-mono">
            {turn.rawJson}
          </pre>
        </details>
      );
  }
}

function TruncatedHint() {
  return (
    <p className="mt-1 text-[10px] uppercase tracking-wide text-amber-300/80">
      Turn body trimmed to fit budget
    </p>
  );
}

function MetadataSidebar({ task }: { task: TaskDetail }) {
  const rows: Array<[string, string]> = [
    ["Status", task.status ?? "—"],
    ["Model", task.model ?? "—"],
    ["Turns", task.numTurns === null ? "—" : String(task.numTurns)],
    ["Exit code", task.exitCode === null ? "—" : String(task.exitCode)],
    ["Task type", task.taskType ?? "—"],
    [
      "Parent task",
      task.parentTaskId === null ? "—" : `#${task.parentTaskId}`,
    ],
    ["Channel", task.channel ?? "—"],
    [
      "Channel ctx",
      task.channelChatId === null && task.channelMessageId === null
        ? "—"
        : `${task.channelChatId ?? "—"} / ${task.channelMessageId ?? "—"}`,
    ],
    ["Session", task.sessionId],
    ["Created", task.createdAt ?? "—"],
    ["Started", task.startedAt ?? "—"],
    ["Completed", task.completedAt ?? "—"],
  ];

  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle>Metadata</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
              <dt className="text-[hsl(var(--muted-foreground))]">{label}</dt>
              <dd className="break-all font-mono">{value}</dd>
            </div>
          ))}
          {task.errorMessage && (
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
              <dt className="text-red-400">Error</dt>
              <dd className="break-all font-mono text-red-400">
                {task.errorMessage}
              </dd>
            </div>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}
