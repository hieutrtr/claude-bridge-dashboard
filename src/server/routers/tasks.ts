// T04/T05/T06 — tasks.* router. T04 introduced `listByAgent` (agent-detail
// Tasks tab feed). T05 added the global `list` (status / agentName /
// channel / since / until filters with cursor pagination) for the
// `/tasks` page. T06 adds `get` (single-row detail for `/tasks/[id]`).
// `transcript` and `stream` belong to T07 / T08; the mutation surface
// (`dispatch`, `kill`, `retry`) is out of Phase 1.
//
// `list*` queries return id-DESC pages keyed by `tasks.id` so the cursor
// (`id < ?`) stays stable under concurrent inserts. Per ARCHITECTURE.md
// §11 — DB query p95 < 50ms on 10k rows paged 50; `get` is a SELECT-by-PK
// well under that budget.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { and, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";

import { publicProcedure, router } from "../trpc";
import { getDb } from "../db";
import { agents, tasks } from "../../db/schema";
import type {
  AgentTaskPage,
  GlobalTaskPage,
  TaskDetail,
  TaskTranscript,
} from "../dto";
import { MARKDOWN_BYTE_LIMIT } from "../../lib/markdown";
import {
  parseTranscript,
  projectSlug,
  transcriptPath,
} from "../../lib/transcript";

// T07 — file-size + turn-count caps. Mirrors v1 ARCH §11 perf budget:
// the wire payload stays bounded at ~25 MB worst case (500 turns ×
// 50 KB per turn). Documented in T07-transcript-viewer.md.
const TRANSCRIPT_FILE_BYTE_LIMIT = 5 * 1024 * 1024;
const MAX_TURNS_PER_TRANSCRIPT = 500;
const TRANSCRIPT_PER_TURN_BYTE_LIMIT = 50_000;

function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
}

const TASK_DTO_SELECTION = {
  id: tasks.id,
  prompt: tasks.prompt,
  status: tasks.status,
  costUsd: tasks.costUsd,
  durationMs: tasks.durationMs,
  channel: tasks.channel,
  createdAt: tasks.createdAt,
  completedAt: tasks.completedAt,
} as const;

const GLOBAL_TASK_DTO_SELECTION = {
  id: tasks.id,
  agentName: agents.name,
  prompt: tasks.prompt,
  status: tasks.status,
  costUsd: tasks.costUsd,
  durationMs: tasks.durationMs,
  channel: tasks.channel,
  createdAt: tasks.createdAt,
  completedAt: tasks.completedAt,
} as const;

const ListByAgentInput = z.object({
  agentName: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.number().int().positive().optional(),
});

// T05 — global Tasks list filters. v1 §4.2 lists `{ sessionId?, status?,
// limit?, cursor? }`; we substitute `agentName` for `sessionId` (resolved
// server-side via the agents table) and add `channel` + `since` + `until`
// to satisfy the Phase 1 acceptance bullet ("filter theo status, agent,
// channel, date range"). All inputs optional, all read-only.
const ListInput = z.object({
  status: z.string().min(1).optional(),
  agentName: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.number().int().positive().optional(),
});

// T06 — single-row detail by primary key. Positive integer; null for
// unknown id (no throw — keeps the page-level `notFound()` clean).
const GetInput = z.object({
  id: z.number().int().positive(),
});

const TASK_DETAIL_SELECTION = {
  id: tasks.id,
  agentName: agents.name,
  sessionId: tasks.sessionId,
  prompt: tasks.prompt,
  status: tasks.status,
  costUsd: tasks.costUsd,
  durationMs: tasks.durationMs,
  numTurns: tasks.numTurns,
  exitCode: tasks.exitCode,
  errorMessage: tasks.errorMessage,
  model: tasks.model,
  taskType: tasks.taskType,
  parentTaskId: tasks.parentTaskId,
  channel: tasks.channel,
  channelChatId: tasks.channelChatId,
  channelMessageId: tasks.channelMessageId,
  createdAt: tasks.createdAt,
  startedAt: tasks.startedAt,
  completedAt: tasks.completedAt,
  resultSummary: tasks.resultSummary,
} as const;

// Clip an arbitrary UTF-8 string at a byte boundary (not a code point
// boundary). Cheaper alternative: encode → slice → decode with
// `fatal: false` so a partial trailing multi-byte sequence is dropped.
function clipUtf8(input: string, byteLimit: number): { value: string; truncated: boolean } {
  const buf = Buffer.from(input, "utf8");
  if (buf.byteLength <= byteLimit) {
    return { value: input, truncated: false };
  }
  // TextDecoder with `fatal: false` (the default) replaces an
  // incomplete trailing sequence with U+FFFD — but since we want to
  // *drop* it cleanly, prefer Node's `Buffer.toString` which silently
  // truncates partial sequences when the slice is mid-codepoint.
  const sliced = buf.subarray(0, byteLimit);
  return { value: sliced.toString("utf8"), truncated: true };
}

export const tasksRouter = router({
  listByAgent: publicProcedure
    .input(ListByAgentInput)
    .query(({ input }): AgentTaskPage => {
      const db = getDb();

      // Resolve agent name → session_id(s). Same name across project
      // dirs maps to multiple sessions; we surface tasks from any of
      // them so the detail page is useful even for the rare collision
      // case (see T04 task spec — Notes).
      const sessions = db
        .select({ sessionId: agents.sessionId })
        .from(agents)
        .where(eq(agents.name, input.agentName))
        .all();
      if (sessions.length === 0) {
        return { items: [], nextCursor: null };
      }
      const sessionIds = sessions.map((s) => s.sessionId);

      const filters = [inArray(tasks.sessionId, sessionIds)];
      if (input.cursor !== undefined) {
        filters.push(lt(tasks.id, input.cursor));
      }

      const items = db
        .select(TASK_DTO_SELECTION)
        .from(tasks)
        .where(and(...filters))
        .orderBy(desc(tasks.id))
        .limit(input.limit)
        .all();

      const nextCursor =
        items.length === input.limit ? (items[items.length - 1]!.id ?? null) : null;
      return { items, nextCursor };
    }),

  list: publicProcedure
    .input(ListInput)
    .query(({ input }): GlobalTaskPage => {
      const db = getDb();

      // agentName filter resolves to a session_id IN (...) clause. If
      // the user typed an unknown name, return an empty page rather
      // than throwing — feels more like search-as-you-go.
      let sessionIds: string[] | null = null;
      if (input.agentName !== undefined) {
        const sessions = db
          .select({ sessionId: agents.sessionId })
          .from(agents)
          .where(eq(agents.name, input.agentName))
          .all();
        if (sessions.length === 0) {
          return { items: [], nextCursor: null };
        }
        sessionIds = sessions.map((s) => s.sessionId);
      }

      const filters = [];
      if (sessionIds !== null) {
        filters.push(inArray(tasks.sessionId, sessionIds));
      }
      if (input.status !== undefined) {
        filters.push(eq(tasks.status, input.status));
      }
      if (input.channel !== undefined) {
        filters.push(eq(tasks.channel, input.channel));
      }
      if (input.since !== undefined) {
        filters.push(gte(tasks.createdAt, input.since));
      }
      if (input.until !== undefined) {
        filters.push(lte(tasks.createdAt, input.until));
      }
      if (input.cursor !== undefined) {
        filters.push(lt(tasks.id, input.cursor));
      }

      const items = db
        .select(GLOBAL_TASK_DTO_SELECTION)
        .from(tasks)
        .leftJoin(agents, eq(tasks.sessionId, agents.sessionId))
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(tasks.id))
        .limit(input.limit)
        .all();

      const nextCursor =
        items.length === input.limit ? (items[items.length - 1]!.id ?? null) : null;
      return { items, nextCursor };
    }),

  get: publicProcedure
    .input(GetInput)
    .query(({ input }): TaskDetail | null => {
      const db = getDb();
      const row = db
        .select(TASK_DETAIL_SELECTION)
        .from(tasks)
        .leftJoin(agents, eq(tasks.sessionId, agents.sessionId))
        .where(eq(tasks.id, input.id))
        .limit(1)
        .all()[0];
      if (!row) return null;

      const { resultSummary, ...rest } = row;
      const clipped =
        resultSummary === null || resultSummary === undefined
          ? { value: null as string | null, truncated: false }
          : clipUtf8(resultSummary, MARKDOWN_BYTE_LIMIT);

      return {
        ...rest,
        resultMarkdown: clipped.value,
        resultMarkdownTruncated: clipped.truncated,
      };
    }),

  // T07 — read the Claude Code session JSONL for a given task. Returns
  // `null` for unknown task ids (mirrors `tasks.get`); for known tasks
  // returns the parsed turns plus sentinels (`fileMissing`,
  // `fileTooLarge`, `truncated`) so the page can render a banner
  // instead of crashing on the rare missing-or-huge path.
  //
  // Read-only: pure `existsSync`/`statSync`/`readFileSync` — no
  // filesystem writes. The on-disk path is constrained to
  // `<CLAUDE_HOME>/projects/<slug>/<session_id>.jsonl` (slug derived
  // from `agents.project_dir`), so the user can't pivot the read to
  // an arbitrary path.
  transcript: publicProcedure
    .input(GetInput)
    .query(({ input }): TaskTranscript | null => {
      const db = getDb();
      const row = db
        .select({
          sessionId: tasks.sessionId,
          projectDir: agents.projectDir,
        })
        .from(tasks)
        .leftJoin(agents, eq(tasks.sessionId, agents.sessionId))
        .where(eq(tasks.id, input.id))
        .limit(1)
        .all()[0];
      if (!row) return null;

      const slug = projectSlug(row.projectDir ?? "");
      const filePath = transcriptPath(claudeHome(), slug, row.sessionId);

      if (!existsSync(filePath)) {
        return {
          filePath,
          fileMissing: true,
          fileTooLarge: false,
          fileBytes: 0,
          totalLines: 0,
          truncated: false,
          turns: [],
        };
      }

      const stats = statSync(filePath);
      if (stats.size > TRANSCRIPT_FILE_BYTE_LIMIT) {
        return {
          filePath,
          fileMissing: false,
          fileTooLarge: true,
          fileBytes: stats.size,
          totalLines: 0,
          truncated: false,
          turns: [],
        };
      }

      const content = readFileSync(filePath, "utf8");
      const parsed = parseTranscript(content, {
        maxTurns: MAX_TURNS_PER_TRANSCRIPT,
        perTurnByteLimit: TRANSCRIPT_PER_TURN_BYTE_LIMIT,
      });
      return {
        filePath,
        fileMissing: false,
        fileTooLarge: false,
        fileBytes: stats.size,
        totalLines: parsed.totalLines,
        truncated: parsed.truncated,
        turns: parsed.turns,
      };
    }),
});
