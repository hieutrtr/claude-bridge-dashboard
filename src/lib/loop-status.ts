// P3-T1 — pure mapping from the daemon's `loops.status` (+ derived
// `pending_approval` flag) to a UI badge {label, variant}. Mirrors
// `taskStatusBadge` / `agentStatusBadge` so both share the existing
// <Badge> primitive variants.
//
// Note: when `pending_approval=true` the daemon keeps `status` at
// `"running"` — the wait-for-human signal lives on a separate column.
// The list page surfaces this as a distinct "Waiting approval" badge
// rather than burying it inside the row's pending_approval pill, so a
// glance at the status column is enough to spot blocked loops.

export type LoopStatusVariant = "running" | "idle" | "error" | "unknown";

export interface LoopStatusBadge {
  label: string;
  variant: LoopStatusVariant;
}

export function loopStatusBadge(
  status: string | null | undefined,
  pendingApproval: boolean,
): LoopStatusBadge {
  if (pendingApproval) {
    return { label: "Waiting approval", variant: "idle" };
  }
  switch (status) {
    case "running":
      return { label: "Running", variant: "running" };
    case "done":
      return { label: "Done", variant: "running" };
    case "cancelled":
    case "canceled":
      return { label: "Cancelled", variant: "idle" };
    case "failed":
      return { label: "Failed", variant: "error" };
    case "waiting_approval":
      return { label: "Waiting approval", variant: "idle" };
    default:
      return { label: "Unknown", variant: "unknown" };
  }
}
