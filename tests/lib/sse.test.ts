import { describe, it, expect } from "bun:test";

import {
  SSE_HEARTBEAT_COMMENT,
  diffTaskSnapshots,
  formatSseComment,
  formatSseEvent,
  type TaskSnapshot,
} from "../../src/lib/sse";

describe("formatSseEvent", () => {
  it("formats a JSON object payload as a single data line", () => {
    expect(formatSseEvent("update", { id: 1, status: "done" })).toBe(
      'event: update\ndata: {"id":1,"status":"done"}\n\n',
    );
  });

  it("JSON-stringifies arbitrary non-string data", () => {
    expect(formatSseEvent("init", { tasks: [{ id: 1 }] })).toBe(
      'event: init\ndata: {"tasks":[{"id":1}]}\n\n',
    );
    expect(formatSseEvent("count", 42)).toBe("event: count\ndata: 42\n\n");
  });

  it("splits a multi-line string into one data line per chunk", () => {
    const out = formatSseEvent("text", "line one\nline two\nline three");
    expect(out).toBe(
      "event: text\ndata: line one\ndata: line two\ndata: line three\n\n",
    );
  });
});

describe("formatSseComment", () => {
  it("emits the SSE comment frame", () => {
    expect(formatSseComment("hi")).toBe(": hi\n\n");
  });
});

describe("SSE_HEARTBEAT_COMMENT", () => {
  it("starts with a colon", () => {
    expect(typeof SSE_HEARTBEAT_COMMENT).toBe("string");
    expect(SSE_HEARTBEAT_COMMENT.length).toBeGreaterThan(0);
    expect(SSE_HEARTBEAT_COMMENT.startsWith(":")).toBe(true);
    expect(SSE_HEARTBEAT_COMMENT.endsWith("\n\n")).toBe(true);
  });
});

describe("diffTaskSnapshots", () => {
  function snap(id: number, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
    return {
      id,
      status: "running",
      costUsd: null,
      completedAt: null,
      ...overrides,
    };
  }

  it("returns no events and an empty snapshot for an empty curr", () => {
    const { events, nextSnapshot } = diffTaskSnapshots(new Map(), []);
    expect(events).toEqual([]);
    expect(nextSnapshot.size).toBe(0);
  });

  it("emits one event per new task on first observation", () => {
    const a = snap(1, { status: "running" });
    const b = snap(2, { status: "queued" });
    const { events, nextSnapshot } = diffTaskSnapshots(new Map(), [a, b]);
    expect(events.length).toBe(2);
    expect(events.map((e) => e.id).sort()).toEqual([1, 2]);
    expect(nextSnapshot.size).toBe(2);
    expect(nextSnapshot.get(1)?.status).toBe("running");
  });

  it("emits zero events when prev and curr are byte-identical", () => {
    const a = snap(1, { status: "done", costUsd: 0.42, completedAt: "2026-05-05 09:00:00" });
    const prev = new Map<number, TaskSnapshot>([[1, a]]);
    const { events, nextSnapshot } = diffTaskSnapshots(prev, [{ ...a }]);
    expect(events).toEqual([]);
    expect(nextSnapshot.size).toBe(1);
  });

  it("emits an update when status changes", () => {
    const before = snap(1, { status: "running" });
    const after = snap(1, { status: "done" });
    const prev = new Map<number, TaskSnapshot>([[1, before]]);
    const { events } = diffTaskSnapshots(prev, [after]);
    expect(events.length).toBe(1);
    expect(events[0]!.id).toBe(1);
    expect(events[0]!.status).toBe("done");
  });

  it("emits an update when costUsd changes", () => {
    const before = snap(1, { status: "done", costUsd: null });
    const after = snap(1, { status: "done", costUsd: 0.13 });
    const prev = new Map<number, TaskSnapshot>([[1, before]]);
    const { events } = diffTaskSnapshots(prev, [after]);
    expect(events.length).toBe(1);
    expect(events[0]!.costUsd).toBe(0.13);
  });

  it("emits an update when completedAt changes", () => {
    const before = snap(1, { status: "done", completedAt: null });
    const after = snap(1, { status: "done", completedAt: "2026-05-05 10:00:00" });
    const prev = new Map<number, TaskSnapshot>([[1, before]]);
    const { events } = diffTaskSnapshots(prev, [after]);
    expect(events.length).toBe(1);
    expect(events[0]!.completedAt).toBe("2026-05-05 10:00:00");
  });

  it("forgets ids that drop out of the curr window", () => {
    const a = snap(1, { status: "done" });
    const b = snap(2, { status: "running" });
    const prev = new Map<number, TaskSnapshot>([
      [1, a],
      [2, b],
    ]);
    // Only `a` shows up this tick; `b` aged out of the LIMIT window.
    const { events, nextSnapshot } = diffTaskSnapshots(prev, [a]);
    expect(events).toEqual([]);
    expect(nextSnapshot.size).toBe(1);
    expect(nextSnapshot.has(2)).toBe(false);
  });

  it("emits new + changed events together in the same tick", () => {
    const oldA = snap(1, { status: "running" });
    const newA = snap(1, { status: "done" });
    const newB = snap(2, { status: "queued" });
    const prev = new Map<number, TaskSnapshot>([[1, oldA]]);
    const { events, nextSnapshot } = diffTaskSnapshots(prev, [newA, newB]);
    expect(events.length).toBe(2);
    const byId = new Map(events.map((e) => [e.id, e]));
    expect(byId.get(1)!.status).toBe("done");
    expect(byId.get(2)!.status).toBe("queued");
    expect(nextSnapshot.size).toBe(2);
  });
});
