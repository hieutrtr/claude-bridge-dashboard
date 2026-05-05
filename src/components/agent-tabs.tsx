// T04 — agent-detail tab strip. Pure presentational; tab state is held
// in the URL via `?tab=tasks|memory|cost`, so each tab is a plain
// `<Link>` and the page server component re-renders accordingly. A
// shared `<Tabs>` shadcn primitive lands later (T10) once Memory tab
// has real content.

import Link from "next/link";

import { cn } from "@/src/lib/utils";

export type AgentTab = "tasks" | "memory" | "cost";

const TABS: ReadonlyArray<{ id: AgentTab; label: string }> = [
  { id: "tasks", label: "Tasks" },
  { id: "memory", label: "Memory" },
  { id: "cost", label: "Cost" },
];

export function AgentTabs({
  active,
  agentName,
}: {
  active: AgentTab;
  agentName: string;
}) {
  const base = `/agents/${encodeURIComponent(agentName)}`;
  return (
    <nav
      aria-label="Agent detail sections"
      className="flex gap-1 border-b border-[hsl(var(--border))]"
    >
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        const href = tab.id === "tasks" ? base : `${base}?tab=${tab.id}`;
        return (
          <Link
            key={tab.id}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "border-b-2 px-4 py-2 text-sm transition-colors",
              isActive
                ? "border-[hsl(var(--foreground))] font-medium text-[hsl(var(--foreground))]"
                : "border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function isAgentTab(value: string | undefined | null): value is AgentTab {
  return value === "tasks" || value === "memory" || value === "cost";
}
