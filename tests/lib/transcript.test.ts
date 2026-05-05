import { describe, it, expect } from "bun:test";

import {
  projectSlug,
  transcriptPath,
  parseTranscriptLine,
  parseTranscript,
  type TranscriptTurn,
} from "../../src/lib/transcript";

describe("projectSlug", () => {
  it("replaces every '/' with '-' for an absolute path", () => {
    expect(projectSlug("/Users/foo/bar")).toBe("-Users-foo-bar");
  });

  it("returns '-' for the root path", () => {
    expect(projectSlug("/")).toBe("-");
  });

  it("returns empty string for empty input", () => {
    expect(projectSlug("")).toBe("");
  });

  it("does not add a leading dash to a relative path", () => {
    expect(projectSlug("relative/path")).toBe("relative-path");
  });

  it("preserves dots and dashes already in the path", () => {
    expect(projectSlug("/Users/hieu/project.foo-bar")).toBe(
      "-Users-hieu-project.foo-bar",
    );
  });
});

describe("transcriptPath", () => {
  it("joins home / 'projects' / slug / sessionId.jsonl", () => {
    expect(transcriptPath("/home", "-Users-x", "abc")).toBe(
      "/home/projects/-Users-x/abc.jsonl",
    );
  });

  it("handles a home with a trailing slash via path.join", () => {
    expect(transcriptPath("/home/", "-Users-x", "abc")).toBe(
      "/home/projects/-Users-x/abc.jsonl",
    );
  });
});

describe("parseTranscriptLine", () => {
  it("returns null for an empty line", () => {
    expect(parseTranscriptLine("")).toBeNull();
    expect(parseTranscriptLine("   ")).toBeNull();
  });

  it("returns kind=raw for a JSON-parse failure", () => {
    const turns = parseTranscriptLine("{not json");
    expect(Array.isArray(turns)).toBe(false);
    const t = turns as TranscriptTurn;
    expect(t.kind).toBe("raw");
    if (t.kind === "raw") {
      expect(t.rawJson).toBe("{not json");
    }
  });

  it("returns kind=user with text for a user/string content line", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u-1",
      timestamp: "2026-05-01T00:00:00.000Z",
      message: { role: "user", content: "hello there" },
    });
    const out = parseTranscriptLine(line);
    expect(Array.isArray(out)).toBe(false);
    const t = out as TranscriptTurn;
    expect(t.kind).toBe("user");
    if (t.kind === "user") {
      expect(t.text).toBe("hello there");
      expect(t.uuid).toBe("u-1");
      expect(t.timestamp).toBe("2026-05-01T00:00:00.000Z");
    }
  });

  it("returns kind=user_tool_result per tool_result element in a user message", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u-2",
      timestamp: "2026-05-01T00:00:01.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "result A" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "result B" },
        ],
      },
    });
    const out = parseTranscriptLine(line);
    expect(Array.isArray(out)).toBe(true);
    const turns = out as TranscriptTurn[];
    expect(turns.length).toBe(2);
    expect(turns[0]!.kind).toBe("user_tool_result");
    if (turns[0]!.kind === "user_tool_result") {
      expect(turns[0]!.toolUseId).toBe("toolu_1");
      expect(turns[0]!.content).toBe("result A");
    }
    if (turns[1]!.kind === "user_tool_result") {
      expect(turns[1]!.toolUseId).toBe("toolu_2");
      expect(turns[1]!.content).toBe("result B");
    }
  });

  it("emits one assistant_text turn per text block, carrying model", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a-1",
      timestamp: "2026-05-01T00:00:02.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [
          { type: "text", text: "Hello!" },
          { type: "text", text: "Second paragraph." },
        ],
      },
    });
    const out = parseTranscriptLine(line);
    expect(Array.isArray(out)).toBe(true);
    const turns = out as TranscriptTurn[];
    expect(turns.length).toBe(2);
    expect(turns[0]!.kind).toBe("assistant_text");
    if (turns[0]!.kind === "assistant_text") {
      expect(turns[0]!.text).toBe("Hello!");
      expect(turns[0]!.model).toBe("claude-opus-4-7");
    }
    if (turns[1]!.kind === "assistant_text") {
      expect(turns[1]!.text).toBe("Second paragraph.");
    }
  });

  it("emits assistant_thinking per thinking block (drops signature)", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a-2",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me ponder.", signature: "secretsig" },
        ],
      },
    });
    const out = parseTranscriptLine(line);
    const turns = out as TranscriptTurn[];
    expect(turns.length).toBe(1);
    expect(turns[0]!.kind).toBe("assistant_thinking");
    if (turns[0]!.kind === "assistant_thinking") {
      expect(turns[0]!.text).toBe("Let me ponder.");
      // Signature must NOT leak onto the wire (it's an opaque
      // model-side blob; rendering it is dead UI).
      expect(JSON.stringify(turns[0])).not.toContain("secretsig");
    }
  });

  it("emits assistant_tool_use per tool_use block with stringified input", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a-3",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_X",
            name: "ToolSearch",
            input: { query: "hello", max_results: 5 },
          },
        ],
      },
    });
    const out = parseTranscriptLine(line);
    const turns = out as TranscriptTurn[];
    expect(turns.length).toBe(1);
    expect(turns[0]!.kind).toBe("assistant_tool_use");
    if (turns[0]!.kind === "assistant_tool_use") {
      expect(turns[0]!.toolName).toBe("ToolSearch");
      expect(turns[0]!.toolUseId).toBe("toolu_X");
      const parsed = JSON.parse(turns[0]!.inputJson);
      expect(parsed).toEqual({ query: "hello", max_results: 5 });
    }
  });

  it("returns kind=meta for unknown top-level types, preserving raw JSON", () => {
    const line = JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-05-01T00:00:00.000Z",
    });
    const out = parseTranscriptLine(line);
    expect(Array.isArray(out)).toBe(false);
    const t = out as TranscriptTurn;
    expect(t.kind).toBe("meta");
    if (t.kind === "meta") {
      expect(t.type).toBe("queue-operation");
      expect(t.rawJson).toContain("\"operation\":\"enqueue\"");
    }
  });

  it("byte-clips an oversized assistant_text block when perTurnByteLimit is set", () => {
    const huge = "a".repeat(60_000);
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a-huge",
      message: {
        role: "assistant",
        content: [{ type: "text", text: huge }],
      },
    });
    const out = parseTranscriptLine(line, { perTurnByteLimit: 50_000 });
    const turns = out as TranscriptTurn[];
    expect(turns.length).toBe(1);
    if (turns[0]!.kind === "assistant_text") {
      expect(turns[0]!.truncated).toBe(true);
      expect(Buffer.byteLength(turns[0]!.text, "utf8")).toBeLessThanOrEqual(50_000);
    }
  });
});

describe("parseTranscript", () => {
  it("parses a multi-line content string in order, totalLines correct", () => {
    const lines = [
      JSON.stringify({ type: "user", uuid: "u-1", message: { role: "user", content: "hi" } }),
      JSON.stringify({
        type: "assistant",
        uuid: "a-1",
        message: { role: "assistant", model: "claude-opus-4-7", content: [{ type: "text", text: "yo" }] },
      }),
      JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
    ].join("\n");

    const result = parseTranscript(lines, { maxTurns: 500, perTurnByteLimit: 50_000 });
    expect(result.totalLines).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.turns.length).toBe(3);
    expect(result.turns[0]!.kind).toBe("user");
    expect(result.turns[1]!.kind).toBe("assistant_text");
    expect(result.turns[2]!.kind).toBe("meta");
  });

  it("keeps the last N turns when total exceeds maxTurns and flags truncated", () => {
    const lines = Array.from({ length: 600 }, (_, i) =>
      JSON.stringify({
        type: "user",
        uuid: `u-${i}`,
        message: { role: "user", content: `msg ${i}` },
      }),
    ).join("\n");

    const result = parseTranscript(lines, { maxTurns: 500, perTurnByteLimit: 50_000 });
    expect(result.totalLines).toBe(600);
    expect(result.truncated).toBe(true);
    expect(result.turns.length).toBe(500);
    // Most-recent kept — first kept turn should correspond to original index 100.
    if (result.turns[0]!.kind === "user") {
      expect(result.turns[0]!.text).toBe("msg 100");
    }
    if (result.turns[499]!.kind === "user") {
      expect(result.turns[499]!.text).toBe("msg 599");
    }
  });

  it("filters empty / whitespace-only lines silently", () => {
    const lines = [
      "",
      JSON.stringify({ type: "user", uuid: "u-1", message: { role: "user", content: "hi" } }),
      "   ",
      JSON.stringify({ type: "user", uuid: "u-2", message: { role: "user", content: "yo" } }),
      "",
    ].join("\n");
    const result = parseTranscript(lines, { maxTurns: 500, perTurnByteLimit: 50_000 });
    expect(result.totalLines).toBe(2);
    expect(result.turns.length).toBe(2);
  });

  it("emits one turn per content block (assistant text + tool_use sequence)", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a-1",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [
          { type: "text", text: "Reading the file..." },
          { type: "tool_use", id: "toolu_X", name: "Read", input: { file_path: "/tmp/foo" } },
        ],
      },
    });
    const result = parseTranscript(line, { maxTurns: 500, perTurnByteLimit: 50_000 });
    expect(result.totalLines).toBe(1);
    expect(result.turns.length).toBe(2);
    expect(result.turns[0]!.kind).toBe("assistant_text");
    expect(result.turns[1]!.kind).toBe("assistant_tool_use");
  });
});
