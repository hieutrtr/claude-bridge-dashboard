// P2-T09 — pure helper tests for the permissions SSE diff logic.
// Mirrors the shape of the task-stream diff (`tests/lib/sse.test.ts`).

import { describe, it, expect } from "bun:test";

import {
  diffPermissionSnapshots,
  type PermissionSnapshot,
} from "../../src/lib/permissions-stream";

function row(
  id: string,
  status: PermissionSnapshot["status"],
  overrides: Partial<PermissionSnapshot> = {},
): PermissionSnapshot {
  return {
    id,
    sessionId: "sess-1",
    toolName: "Bash",
    command: "ls",
    description: null,
    status,
    createdAt: "2026-05-06 10:00:00",
    timeoutSeconds: 300,
    ...overrides,
  };
}

function snap(rows: PermissionSnapshot[]): Map<string, PermissionSnapshot> {
  return new Map(rows.map((r) => [r.id, r]));
}

describe("diffPermissionSnapshots", () => {
  it("returns no events when prev == curr", () => {
    const prev = snap([row("a", "pending")]);
    const curr = [row("a", "pending")];
    const out = diffPermissionSnapshots(prev, curr);
    expect(out.pendingEvents).toEqual([]);
    expect(out.resolvedEvents).toEqual([]);
  });

  it("emits one pendingEvents entry for a brand-new pending row", () => {
    const prev = snap([]);
    const curr = [row("a", "pending")];
    const out = diffPermissionSnapshots(prev, curr);
    expect(out.pendingEvents.length).toBe(1);
    expect(out.pendingEvents[0]!.id).toBe("a");
    expect(out.resolvedEvents).toEqual([]);
  });

  it("does not emit pendingEvents for new non-pending rows", () => {
    // Tail rows from the route's 30s window can land here on first
    // tick. They're already resolved → no toast.
    const prev = snap([]);
    const curr = [row("a", "approved"), row("b", "denied")];
    const out = diffPermissionSnapshots(prev, curr);
    expect(out.pendingEvents).toEqual([]);
    // We don't synthesize a resolved event for rows we've never seen
    // pending — that would spam the toast on dashboard reload.
    expect(out.resolvedEvents).toEqual([]);
  });

  it("emits resolvedEvents (status:approved) when a row flips pending → approved", () => {
    const prev = snap([row("a", "pending")]);
    const curr = [row("a", "approved")];
    const out = diffPermissionSnapshots(prev, curr);
    expect(out.resolvedEvents.length).toBe(1);
    expect(out.resolvedEvents[0]).toEqual({ id: "a", status: "approved" });
    expect(out.pendingEvents).toEqual([]);
  });

  it("emits resolvedEvents (status:denied) when a row flips pending → denied", () => {
    const prev = snap([row("a", "pending")]);
    const curr = [row("a", "denied")];
    const out = diffPermissionSnapshots(prev, curr);
    expect(out.resolvedEvents).toEqual([{ id: "a", status: "denied" }]);
  });

  it("emits resolvedEvents{status:denied} when a previously-pending row drops out of the snapshot", () => {
    // Defensive: if the daemon archives a permission we never saw
    // resolve, the toast must clear itself anyway. We pick `denied`
    // as the safe default — refusing the (now-stale) approval intent.
    const prev = snap([row("a", "pending")]);
    const curr: PermissionSnapshot[] = [];
    const out = diffPermissionSnapshots(prev, curr);
    expect(out.resolvedEvents).toEqual([{ id: "a", status: "denied" }]);
    expect(out.pendingEvents).toEqual([]);
  });

  it("does not emit a silent-deny event for non-pending rows that drop out", () => {
    // Rows in the resolved-tail window naturally roll off; that's
    // not a toast-clear signal — the toast already cleared them
    // when they flipped.
    const prev = snap([row("a", "approved")]);
    const curr: PermissionSnapshot[] = [];
    const out = diffPermissionSnapshots(prev, curr);
    expect(out.pendingEvents).toEqual([]);
    expect(out.resolvedEvents).toEqual([]);
  });

  it("emits multiple events in one tick when several rows change", () => {
    const prev = snap([
      row("a", "pending"),
      row("b", "pending"),
      row("c", "pending"),
    ]);
    const curr = [
      row("a", "approved"),
      row("b", "pending"),
      row("c", "denied"),
      row("d", "pending"), // brand new
    ];
    const out = diffPermissionSnapshots(prev, curr);
    expect(out.pendingEvents.map((e) => e.id)).toEqual(["d"]);
    expect(out.resolvedEvents).toEqual([
      { id: "a", status: "approved" },
      { id: "c", status: "denied" },
    ]);
  });

  it("nextSnapshot is keyed by id with the *current* row values", () => {
    const prev = snap([row("a", "pending")]);
    const curr = [row("a", "approved", { command: "rm -rf /" })];
    const out = diffPermissionSnapshots(prev, curr);
    expect(out.nextSnapshot.get("a")?.status).toBe("approved");
    expect(out.nextSnapshot.get("a")?.command).toBe("rm -rf /");
  });
});
