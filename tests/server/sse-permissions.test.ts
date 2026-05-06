// P2-T09 — SSE response tests for /api/stream/permissions.
// Mirrors `tests/server/sse-tasks.test.ts`.

import { describe, it, expect } from "bun:test";

import { createPermissionStreamResponse } from "../../src/server/sse-permissions";
import type { PermissionSnapshot } from "../../src/lib/permissions-stream";

const DECODER = new TextDecoder();

async function readNextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 1000,
): Promise<string | null> {
  const result = await Promise.race([
    reader.read(),
    new Promise<{ value: undefined; done: true }>((resolve) =>
      setTimeout(() => resolve({ value: undefined, done: true }), timeoutMs),
    ),
  ]);
  if (result.done) return null;
  return DECODER.decode(result.value);
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const chunk = await readNextChunk(reader, remaining);
    if (chunk === null) break;
    buf += chunk;
    if (predicate(buf)) return buf;
  }
  throw new Error(`readUntil timed out; buffer so far:\n${buf}`);
}

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

describe("createPermissionStreamResponse", () => {
  it("returns a Response with SSE headers", () => {
    const ac = new AbortController();
    const res = createPermissionStreamResponse({
      signal: ac.signal,
      pollMs: 50,
      heartbeatMs: 200,
      readSnapshot: () => [],
    });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control") ?? "").toContain("no-cache");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    ac.abort();
  });

  it("emits an init event with the initial snapshot", async () => {
    const ac = new AbortController();
    const initial: PermissionSnapshot[] = [
      row("perm-a", "pending", { toolName: "Bash", command: "rm -rf /tmp/x" }),
    ];
    const res = createPermissionStreamResponse({
      signal: ac.signal,
      pollMs: 50,
      heartbeatMs: 1000,
      readSnapshot: () => initial,
    });
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (b) => b.includes("event: init"));
    expect(text).toContain("event: init");
    expect(text).toContain('"id":"perm-a"');
    expect(text).toContain('"toolName":"Bash"');
    ac.abort();
    reader.cancel().catch(() => {});
  });

  it("emits a pending event when a new pending row appears", async () => {
    const ac = new AbortController();
    const queue: PermissionSnapshot[][] = [
      [],
      [row("perm-1", "pending", { toolName: "Edit" })],
    ];
    let i = 0;
    const res = createPermissionStreamResponse({
      signal: ac.signal,
      pollMs: 30,
      heartbeatMs: 1000,
      readSnapshot: () => queue[Math.min(i++, queue.length - 1)]!,
    });
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (b) => /event: pending/.test(b));
    expect(text).toContain("event: pending");
    expect(text).toContain('"id":"perm-1"');
    expect(text).toContain('"toolName":"Edit"');
    ac.abort();
    reader.cancel().catch(() => {});
  });

  it("emits a resolved event when a pending row flips to approved", async () => {
    const ac = new AbortController();
    const queue: PermissionSnapshot[][] = [
      [row("perm-9", "pending")],
      [row("perm-9", "approved")],
    ];
    let i = 0;
    const res = createPermissionStreamResponse({
      signal: ac.signal,
      pollMs: 30,
      heartbeatMs: 1000,
      readSnapshot: () => queue[Math.min(i++, queue.length - 1)]!,
    });
    const reader = res.body!.getReader();
    const text = await readUntil(
      reader,
      (b) => /event: resolved[\s\S]*"status":"approved"/.test(b),
    );
    expect(text).toContain("event: resolved");
    expect(text).toContain('"id":"perm-9"');
    expect(text).toContain('"status":"approved"');
    ac.abort();
    reader.cancel().catch(() => {});
  });

  it("emits a heartbeat comment on the heartbeat cadence", async () => {
    const ac = new AbortController();
    const res = createPermissionStreamResponse({
      signal: ac.signal,
      pollMs: 1000,
      heartbeatMs: 30,
      readSnapshot: () => [],
    });
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (b) => /:\s*heartbeat/.test(b));
    expect(text).toMatch(/^:\s*heartbeat/m);
    ac.abort();
    reader.cancel().catch(() => {});
  });

  it("closes the stream when the signal is aborted", async () => {
    const ac = new AbortController();
    const res = createPermissionStreamResponse({
      signal: ac.signal,
      pollMs: 30,
      heartbeatMs: 1000,
      readSnapshot: () => [],
    });
    const reader = res.body!.getReader();
    await readUntil(reader, (b) => b.includes("event: init"));
    ac.abort();
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 500),
      ),
    ]);
    expect(result.done).toBe(true);
  });
});
