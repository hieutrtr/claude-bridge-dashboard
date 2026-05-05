// T03 — pure mapping from the daemon's `agents.state` text column to a
// UI badge {label, variant}. Defensive default for unknown / null states
// so the dashboard never crashes if the daemon adds a new state.

export type AgentStatusVariant = "running" | "idle" | "error" | "unknown";

export interface AgentStatusBadge {
  label: string;
  variant: AgentStatusVariant;
}

export function agentStatusBadge(state: string | null | undefined): AgentStatusBadge {
  switch (state) {
    case "running":
      return { label: "Running", variant: "running" };
    case "idle":
      return { label: "Idle", variant: "idle" };
    case "created":
      return { label: "Created", variant: "idle" };
    case "errored":
      return { label: "Errored", variant: "error" };
    case "killed":
      return { label: "Killed", variant: "error" };
    default:
      return { label: "Unknown", variant: "unknown" };
  }
}
