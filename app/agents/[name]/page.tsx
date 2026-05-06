// T04/T10 — agent detail page. Server component that resolves the
// dynamic `[name]` segment, fetches the agent + (when on Tasks tab)
// its 50 most recent tasks, + (when on Memory tab) the rendered
// auto-memory directory, via tRPC `createCaller` (in-process — no
// HTTP roundtrip). 404s if the agent is missing.
//
// Cost tab still renders a placeholder — surfacing the per-agent
// slice of the dashboard cost analytics is Phase 2 polish.
//
// Read-only invariant (Phase 1): no `<form action method="post">`,
// no Server Action, no mutation procedure call.

import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";

import { appRouter } from "@/src/server/routers/_app";
import { getSessionSubject } from "@/src/server/session";
import { agentStatusBadge } from "@/src/lib/agent-status";
import { MARKDOWN_REHYPE_PLUGINS } from "@/src/lib/markdown";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/card";
import { TaskTable } from "@/src/components/task-table";
import { AgentTabs, isAgentTab, type AgentTab } from "@/src/components/agent-tabs";
import type { AgentMemory } from "@/src/server/dto";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readTab(raw: string | string[] | undefined): AgentTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isAgentTab(value) ? value : "tasks";
}

function readCursor(raw: string | string[] | undefined): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export default async function AgentDetailPage({ params, searchParams }: PageProps) {
  const { name: rawName } = await params;
  const sp = await searchParams;
  const name = decodeURIComponent(rawName);
  const tab = readTab(sp.tab);
  const cursor = readCursor(sp.cursor);

  const userId = await getSessionSubject();
  const caller = appRouter.createCaller({ userId });
  const agent = await caller.agents.get({ name });
  if (!agent) {
    notFound();
  }

  const badge = agentStatusBadge(agent.state);
  const taskPage =
    tab === "tasks"
      ? await caller.tasks.listByAgent({ agentName: agent.name, limit: 50, cursor })
      : null;
  const memory =
    tab === "memory" ? await caller.agents.memory({ name: agent.name }) : null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold break-all">{agent.name}</h1>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <div
          className="break-all font-mono text-xs text-[hsl(var(--muted-foreground))]"
          title={agent.projectDir}
        >
          {agent.projectDir}
        </div>
        <div className="flex gap-4 text-sm text-[hsl(var(--muted-foreground))]">
          <span>
            Model: <span className="font-mono">{agent.model ?? "—"}</span>
          </span>
          <span>
            Total tasks:{" "}
            <span className="font-mono">{agent.totalTasks ?? 0}</span>
          </span>
          <span>
            Last task:{" "}
            <span className="font-mono">{agent.lastTaskAt ?? "—"}</span>
          </span>
        </div>
      </header>

      <AgentTabs active={tab} agentName={agent.name} />

      {tab === "tasks" && taskPage && (
        <TaskTable
          items={taskPage.items}
          nextCursor={taskPage.nextCursor}
          agentName={agent.name}
        />
      )}
      {tab === "memory" && memory && <MemorySection memory={memory} />}
      {tab === "cost" && <CostTabPlaceholder />}
    </div>
  );
}

function MemorySection({ memory }: { memory: AgentMemory }) {
  const showEmpty = memory.dirMissing || memory.fileMissing;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Memory</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {memory.fileTooLarge && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <code className="font-mono">MEMORY.md</code> is too large to render
            ({memory.fileBytes.toLocaleString("en-US")} bytes). Open the file
            directly at{" "}
            <code className="font-mono break-all">{memory.dirPath}</code>.
          </p>
        )}
        {memory.memoryMdTruncated && !memory.fileTooLarge && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Memory truncated to 500 KB. Inspect the raw file for the full
            content.
          </p>
        )}

        {memory.memoryMd && memory.memoryMd.length > 0 ? (
          <div className="markdown-body break-words text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-[hsl(var(--muted))] [&_code]:px-1 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-[hsl(var(--muted))] [&_pre]:p-3">
            <ReactMarkdown rehypePlugins={MARKDOWN_REHYPE_PLUGINS}>
              {memory.memoryMd}
            </ReactMarkdown>
          </div>
        ) : showEmpty ? (
          <div className="space-y-2 text-sm text-[hsl(var(--muted-foreground))]">
            <p>
              No memory recorded for this agent yet. Claude Code writes
              memory files under{" "}
              <code className="font-mono break-all">{memory.dirPath}</code> as
              the agent learns.
            </p>
          </div>
        ) : null}

        {memory.files.length > 0 && (
          <div className="space-y-1 border-t border-[hsl(var(--border))] pt-3">
            <p className="text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
              Files in {memory.dirPath}
            </p>
            <ul className="flex flex-wrap gap-2 text-xs">
              {memory.files.map((f) => (
                <li
                  key={f}
                  className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-2 py-1 font-mono"
                >
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CostTabPlaceholder() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          Per-agent cost slice — Phase 2 polish. The dashboard-wide cost
          analytics is at <code className="mx-1 font-mono">/cost</code>.
        </p>
      </CardContent>
    </Card>
  );
}
