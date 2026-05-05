// T03/T04/T10 — agents.* router. T03 introduced `list` (DTO projection);
// T04 added `get(name)` for the agent-detail page route; T10 adds
// `memory(name)` for the agent-detail Memory tab. Other §4.1 procedures
// (`status`, `stream`) belong to Phase 2+. No mutation procedures in
// Phase 1.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { asc, eq } from "drizzle-orm";

import { publicProcedure, router } from "../trpc";
import { getDb } from "../db";
import { agents } from "../../db/schema";
import type { Agent, AgentMemory } from "../dto";
import { MARKDOWN_BYTE_LIMIT } from "../../lib/markdown";
import { projectSlug } from "../../lib/transcript";

const AGENT_DTO_SELECTION = {
  name: agents.name,
  projectDir: agents.projectDir,
  model: agents.model,
  state: agents.state,
  lastTaskAt: agents.lastTaskAt,
  totalTasks: agents.totalTasks,
} as const;

// T10 — defensive cap on the sibling-file directory listing. The
// observed memory layout has ≤ ~10 entries; 200 is generous enough that
// power-user setups don't get clipped while still bounding the wire
// payload + render cost when something is wrong.
const MEMORY_FILES_CAP = 200;

function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
}

export const agentsRouter = router({
  list: publicProcedure.query((): Agent[] => {
    return getDb()
      .select(AGENT_DTO_SELECTION)
      .from(agents)
      .all();
  }),

  // §4.1 `agents.get({ name }) → Agent | null`. The schema PK is
  // (name, project_dir) so a single name can — in theory — match more
  // than one row across different project dirs. We tie-break on
  // project_dir ASC so the result is deterministic; in the single-user
  // setup this collision is rare. T11 may add a UI affordance if this
  // turns out to bite anyone.
  get: publicProcedure
    .input(z.object({ name: z.string().min(1) }))
    .query(({ input }): Agent | null => {
      const rows = getDb()
        .select(AGENT_DTO_SELECTION)
        .from(agents)
        .where(eq(agents.name, input.name))
        .orderBy(asc(agents.projectDir))
        .limit(1)
        .all();
      return rows[0] ?? null;
    }),

  // §4.1 `agents.memory({ name }) → { memoryMd, files } | null`.
  // Reads `<CLAUDE_HOME>/projects/<projectSlug(projectDir)>/memory/`.
  // Read-only: only `existsSync` / `statSync` / `readdirSync` /
  // `readFileSync` — no filesystem writes. The on-disk path is
  // constrained to the agent's own slug, so the user can't pivot the
  // read to an arbitrary path.
  memory: publicProcedure
    .input(z.object({ name: z.string().min(1) }))
    .query(({ input }): AgentMemory | null => {
      const row = getDb()
        .select({ projectDir: agents.projectDir })
        .from(agents)
        .where(eq(agents.name, input.name))
        .orderBy(asc(agents.projectDir))
        .limit(1)
        .all()[0];
      if (!row) return null;

      const slug = projectSlug(row.projectDir);
      const dirPath = join(claudeHome(), "projects", slug, "memory");

      if (!existsSync(dirPath)) {
        return {
          projectDir: row.projectDir,
          dirPath,
          dirMissing: true,
          fileMissing: true,
          fileTooLarge: false,
          fileBytes: 0,
          memoryMd: null,
          memoryMdTruncated: false,
          files: [],
        };
      }

      // List sibling files. We only consider top-level entries (no
      // recursive walk) and surface only `*.md` filenames, sorted
      // ascending, capped at `MEMORY_FILES_CAP` to bound the wire
      // payload when the directory is misused.
      const allEntries = readdirSync(dirPath, { withFileTypes: true });
      const files = allEntries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name)
        .sort()
        .slice(0, MEMORY_FILES_CAP);

      const memoryFile = join(dirPath, "MEMORY.md");
      if (!existsSync(memoryFile)) {
        return {
          projectDir: row.projectDir,
          dirPath,
          dirMissing: false,
          fileMissing: true,
          fileTooLarge: false,
          fileBytes: 0,
          memoryMd: null,
          memoryMdTruncated: false,
          files,
        };
      }

      const stats = statSync(memoryFile);
      if (stats.size > MARKDOWN_BYTE_LIMIT) {
        return {
          projectDir: row.projectDir,
          dirPath,
          dirMissing: false,
          fileMissing: false,
          fileTooLarge: true,
          fileBytes: stats.size,
          memoryMd: null,
          memoryMdTruncated: false,
          files,
        };
      }

      const content = readFileSync(memoryFile, "utf8");
      // Defence-in-depth: file size ≤ MARKDOWN_BYTE_LIMIT in bytes,
      // but the UTF-8 string length may differ slightly. Re-check on
      // the decoded string and flag `memoryMdTruncated` if the byte
      // count of `content` exceeds the cap (in practice this never
      // fires once we've passed the `stats.size` gate).
      const contentBytes = Buffer.byteLength(content, "utf8");
      const truncated = contentBytes > MARKDOWN_BYTE_LIMIT;
      return {
        projectDir: row.projectDir,
        dirPath,
        dirMissing: false,
        fileMissing: false,
        fileTooLarge: false,
        fileBytes: stats.size,
        memoryMd: content,
        memoryMdTruncated: truncated,
        files,
      };
    }),
});

// Re-export for any sibling router that wants the same DTO shape.
export { AGENT_DTO_SELECTION };
