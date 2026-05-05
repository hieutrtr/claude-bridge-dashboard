// T04 — pure mapping from the daemon's `tasks.status` text column to a
// UI badge {label, variant}. Mirrors the shape of `agentStatusBadge` so
// both share the existing <Badge> primitive variants. A dedicated
// "success" variant is deferred until T12 polishes the palette; for now
// `done` reuses `running` (green-ish) because it semantically matches.

export type TaskStatusVariant = "running" | "idle" | "error" | "unknown";

export interface TaskStatusBadge {
  label: string;
  variant: TaskStatusVariant;
}

export function taskStatusBadge(status: string | null | undefined): TaskStatusBadge {
  switch (status) {
    case "pending":
      return { label: "Pending", variant: "idle" };
    case "queued":
      return { label: "Queued", variant: "idle" };
    case "running":
      return { label: "Running", variant: "running" };
    case "done":
      return { label: "Done", variant: "running" };
    case "failed":
      return { label: "Failed", variant: "error" };
    case "killed":
      return { label: "Killed", variant: "error" };
    default:
      return { label: "Unknown", variant: "unknown" };
  }
}
