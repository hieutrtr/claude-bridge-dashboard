import { describe, it, expect } from "bun:test";

import { createTaskStreamResponse } from "../../src/server/sse-tasks";
import type { TaskSnapshot } from "../../src/lib/sse";

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

describe("createTaskStreamResponse", () => {
  it("returns a Response with SSE headers", () => {
    const ac = new AbortController();
    const res = createTaskStreamResponse({
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
    const initial: TaskSnapshot[] = [
      { id: 2, status: "running", costUsd: null, completedAt: null },
      { id: 1, status: "done", costUsd: 0.5, completedAt: "2026-05-05 10:00:00" },
    ];
    const res = createTaskStreamResponse({
      signal: ac.signal,
      pollMs: 50,
      heartbeatMs: 1000,
      readSnapshot: () => initial,
    });
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (b) => b.includes("event: init"));
    expect(text).toContain("event: init");
    expect(text).toContain('"id":2');
    expect(text).toContain('"id":1');
    expect(text).toContain('"status":"done"');
    ac.abort();
    reader.cancel().catch(() => {});
  });

  it("emits an update event when a new task appears", async () => {
    const ac = new AbortController();
    const queue: TaskSnapshot[][] = [
      [{ id: 1, status: "running", costUsd: null, completedAt: null }],
      [
        { id: 2, status: "queued", costUsd: null, completedAt: null },
        { id: 1, status: "running", costUsd: null, completedAt: null },
      ],
    ];
    let i = 0;
    const res = createTaskStreamResponse({
      signal: ac.signal,
      pollMs: 30,
      heartbeatMs: 1000,
      readSnapshot: () => queue[Math.min(i++, queue.length - 1)]!,
    });
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (b) => /event: update[\s\S]*"id":2/.test(b));
    expect(text).toContain("event: update");
    expect(text).toContain('"id":2');
    expect(text).toContain('"status":"queued"');
    ac.abort();
    reader.cancel().catch(() => {});
  });

  it("emits an update event when status changes", async () => {
    const ac = new AbortController();
    const queue: TaskSnapshot[][] = [
      [{ id: 1, status: "running", costUsd: null, completedAt: null }],
      [{ id: 1, status: "done", costUsd: 0.42, completedAt: "2026-05-05 10:00:00" }],
    ];
    let i = 0;
    const res = createTaskStreamResponse({
      signal: ac.signal,
      pollMs: 30,
      heartbeatMs: 1000,
      readSnapshot: () => queue[Math.min(i++, queue.length - 1)]!,
    });
    const reader = res.body!.getReader();
    const text = await readUntil(
      reader,
      (b) => /event: update[\s\S]*"status":"done"/.test(b),
    );
    expect(text).toContain('"status":"done"');
    expect(text).toContain('"costUsd":0.42');
    ac.abort();
    reader.cancel().catch(() => {});
  });

  it("emits a heartbeat comment on the heartbeat cadence", async () => {
    const ac = new AbortController();
    const res = createTaskStreamResponse({
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
    const res = createTaskStreamResponse({
      signal: ac.signal,
      pollMs: 30,
      heartbeatMs: 1000,
      readSnapshot: () => [],
    });
    const reader = res.body!.getReader();
    // Consume the init frame so subsequent reads block on the stream tick.
    await readUntil(reader, (b) => b.includes("event: init"));
    ac.abort();
    // After abort, the reader should resolve with done within a short window.
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 500),
      ),
    ]);
    expect(result.done).toBe(true);
  });
});
