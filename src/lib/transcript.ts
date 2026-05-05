// T07 — Claude Code session JSONL parser. Pure helpers (no I/O) so the
// procedure layer (`tasks.transcript`) and the test suite share the same
// structural assumptions. Tagged-union `TranscriptTurn` lets the page
// render via discriminated switch — a future format change only needs to
// add a new arm rather than restructuring the renderer.
//
// Per ARCHITECTURE.md §10 + Risk #3 (JSONL format drift), unknown line
// shapes fall through to `meta` (preserves the raw JSON inside a
// collapsed `<details>`) or `raw` (line failed to JSON.parse) so a future
// Claude Code release can't crash the page — worst case the user sees a
// raw-JSON dump for the new turn type.

import { join } from "node:path";

export interface TranscriptParseOptions {
  /** Per-turn UTF-8 byte cap for `assistant_text` / `assistant_thinking`
   *  / `user` / `user_tool_result` / `system` text payloads. The
   *  procedure layer passes 50_000; tests can pass a smaller value. */
  perTurnByteLimit?: number;
}

export interface ParseTranscriptOptions extends TranscriptParseOptions {
  /** Maximum number of turns to keep. The most-recent N are retained;
   *  older turns are dropped. Set `truncated: true` when this triggers. */
  maxTurns: number;
}

export type TranscriptTurn =
  | {
      kind: "user";
      uuid: string | null;
      timestamp: string | null;
      text: string;
      truncated: boolean;
    }
  | {
      kind: "user_tool_result";
      uuid: string | null;
      timestamp: string | null;
      toolUseId: string;
      content: string;
      truncated: boolean;
    }
  | {
      kind: "assistant_text";
      uuid: string | null;
      timestamp: string | null;
      model: string | null;
      text: string;
      truncated: boolean;
    }
  | {
      kind: "assistant_thinking";
      uuid: string | null;
      timestamp: string | null;
      text: string;
      truncated: boolean;
    }
  | {
      kind: "assistant_tool_use";
      uuid: string | null;
      timestamp: string | null;
      toolName: string;
      toolUseId: string;
      inputJson: string;
    }
  | {
      kind: "system";
      uuid: string | null;
      timestamp: string | null;
      text: string;
      truncated: boolean;
    }
  | {
      kind: "meta";
      type: string;
      rawJson: string;
    }
  | {
      kind: "raw";
      rawJson: string;
    };

export interface TranscriptParseResult {
  turns: TranscriptTurn[];
  /** Total non-empty source lines (counted before maxTurns clipping). */
  totalLines: number;
  /** True when older turns were dropped to fit `maxTurns`. */
  truncated: boolean;
}

/** Claude Code stores per-project session files at
 *  `~/.claude/projects/<slug>/`. The slug is the absolute project dir
 *  with every '/' replaced by '-'. Verified by inspecting
 *  `~/.claude/projects/` on the host. */
export function projectSlug(projectDir: string): string {
  return projectDir.replace(/\//g, "-");
}

export function transcriptPath(
  home: string,
  slug: string,
  sessionId: string,
): string {
  return join(home, "projects", slug, `${sessionId}.jsonl`);
}

function clipUtf8(input: string, byteLimit: number): {
  value: string;
  truncated: boolean;
} {
  const buf = Buffer.from(input, "utf8");
  if (buf.byteLength <= byteLimit) {
    return { value: input, truncated: false };
  }
  return { value: buf.subarray(0, byteLimit).toString("utf8"), truncated: true };
}

function clipText(
  text: string,
  opts: TranscriptParseOptions,
): { value: string; truncated: boolean } {
  if (opts.perTurnByteLimit === undefined) {
    return { value: text, truncated: false };
  }
  return clipUtf8(text, opts.perTurnByteLimit);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

interface AssistantContentBlock {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

interface UserContentBlock {
  type?: string;
  tool_use_id?: unknown;
  content?: unknown;
}

/**
 * Parse a single JSONL line into 0..N turns.
 *
 * Returns:
 * - `null` for empty / whitespace-only lines.
 * - A single `TranscriptTurn` for top-level types that emit one turn
 *   (`user`-string, `system`, `meta`, `raw`).
 * - An array of `TranscriptTurn` when the line emits one turn per
 *   content block (assistant content array, user tool_result array).
 *
 * The shape choice (single vs array) is what the unit tests assert
 * against. `parseTranscript` flattens both into a single sequence.
 */
export function parseTranscriptLine(
  line: string,
  opts: TranscriptParseOptions = {},
): TranscriptTurn | TranscriptTurn[] | null {
  if (line.trim() === "") return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: "raw", rawJson: line };
  }

  const type = asString(parsed.type);
  const uuid = asNullableString(parsed.uuid);
  const timestamp = asNullableString(parsed.timestamp);

  if (type === "user") {
    const message = (parsed.message ?? {}) as Record<string, unknown>;
    const content = message.content;

    if (typeof content === "string") {
      const clipped = clipText(content, opts);
      return {
        kind: "user",
        uuid,
        timestamp,
        text: clipped.value,
        truncated: clipped.truncated,
      };
    }

    if (Array.isArray(content)) {
      const out: TranscriptTurn[] = [];
      for (const blockRaw of content) {
        const block = (blockRaw ?? {}) as UserContentBlock;
        if (block.type === "tool_result") {
          const body =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? null);
          const clipped = clipText(body, opts);
          out.push({
            kind: "user_tool_result",
            uuid,
            timestamp,
            toolUseId: asString(block.tool_use_id),
            content: clipped.value,
            truncated: clipped.truncated,
          });
        }
      }
      return out;
    }

    // Unknown user-message shape → meta fallback.
    return { kind: "meta", type, rawJson: line };
  }

  if (type === "assistant") {
    const message = (parsed.message ?? {}) as Record<string, unknown>;
    const model = asNullableString(message.model);
    const content = message.content;
    if (!Array.isArray(content)) {
      return { kind: "meta", type, rawJson: line };
    }
    const out: TranscriptTurn[] = [];
    for (const blockRaw of content) {
      const block = (blockRaw ?? {}) as AssistantContentBlock;
      if (block.type === "text") {
        const text = asString(block.text);
        const clipped = clipText(text, opts);
        out.push({
          kind: "assistant_text",
          uuid,
          timestamp,
          model,
          text: clipped.value,
          truncated: clipped.truncated,
        });
      } else if (block.type === "thinking") {
        const text = asString(block.thinking);
        const clipped = clipText(text, opts);
        out.push({
          kind: "assistant_thinking",
          uuid,
          timestamp,
          text: clipped.value,
          truncated: clipped.truncated,
        });
      } else if (block.type === "tool_use") {
        const inputJson = JSON.stringify(block.input ?? null);
        out.push({
          kind: "assistant_tool_use",
          uuid,
          timestamp,
          toolName: asString(block.name),
          toolUseId: asString(block.id),
          inputJson,
        });
      }
      // Other block types (e.g. future shapes) → silently dropped at
      // the block level. The line itself still contributes to the
      // total turn count via the assistant_* turns we did emit. If a
      // future Claude Code release introduces a new block type that
      // matters, add an arm here.
    }
    return out;
  }

  if (type === "system") {
    const text = asString(parsed.content);
    const clipped = clipText(text, opts);
    return {
      kind: "system",
      uuid,
      timestamp,
      text: clipped.value,
      truncated: clipped.truncated,
    };
  }

  // Anything else — `permission-mode`, `queue-operation`, `attachment`,
  // `last-prompt`, `task_reminder`, `date_change`, `skill_listing`,
  // `mcp_instructions_delta`, `deferred_tools_delta`, future unknowns —
  // surfaces as a meta turn with the raw JSON preserved.
  return { kind: "meta", type, rawJson: line };
}

export function parseTranscript(
  content: string,
  opts: ParseTranscriptOptions,
): TranscriptParseResult {
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  const turns: TranscriptTurn[] = [];
  for (const line of lines) {
    const out = parseTranscriptLine(line, opts);
    if (out === null) continue;
    if (Array.isArray(out)) {
      for (const t of out) turns.push(t);
    } else {
      turns.push(out);
    }
  }
  const totalLines = lines.length;
  if (turns.length > opts.maxTurns) {
    return {
      turns: turns.slice(turns.length - opts.maxTurns),
      totalLines,
      truncated: true,
    };
  }
  return { turns, totalLines, truncated: false };
}
