// T03 — explicit DTO types returned by tRPC procedures.
//
// We intentionally hand-write these instead of leaning on
// `InferSelectModel<typeof agents>` so the wire payload only carries what
// the UI actually renders (perf budget §11) and so the dashboard is not
// tied 1:1 to schema columns the daemon may rename later.

export interface Agent {
  name: string;
  projectDir: string;
  model: string | null;
  state: string | null;
  lastTaskAt: string | null;
  totalTasks: number | null;
}

// T04 — wire shape returned by `tasks.listByAgent`. Subset of the daemon
// `tasks` table — we drop sensitive / detail-page-only columns
// (`session_id`, `result_file`, `pid`, `error_message`, `parent_task_id`,
// etc.) so the agent-detail Tasks tab only ships what it renders. The
// global `/tasks` page (T05) and task detail page (T06) will introduce
// their own DTOs as needed.
export interface AgentTaskRow {
  id: number;
  prompt: string;
  status: string | null;
  costUsd: number | null;
  durationMs: number | null;
  channel: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

export interface AgentTaskPage {
  items: AgentTaskRow[];
  nextCursor: number | null;
}

// T05 — wire shape returned by `tasks.list` (the global Tasks page).
// Same column set as `AgentTaskRow` plus the resolved `agentName` so the
// table can render a per-row link to `/agents/[name]` without a second
// round-trip. `agentName` is nullable for orphaned tasks (session_id
// pointing at an agent that has been deleted).
export interface GlobalTaskRow {
  id: number;
  agentName: string | null;
  prompt: string;
  status: string | null;
  costUsd: number | null;
  durationMs: number | null;
  channel: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

export interface GlobalTaskPage {
  items: GlobalTaskRow[];
  nextCursor: number | null;
}

// T06 — wire shape returned by `tasks.get`. Curated subset of the daemon
// `tasks` table joined with `agents.name` for the agent link in the page
// header. Internal columns (`pid`, `result_file`, `user_id`, `reported`,
// `position`) are explicitly omitted — the dashboard never surfaces a
// daemon-side disk path or process id.
//
// `resultMarkdown` mirrors `tasks.result_summary` clipped to
// `MARKDOWN_BYTE_LIMIT` bytes (UTF-8). When clipping happens,
// `resultMarkdownTruncated === true` so the UI can banner the cap.
// The transcript surface (T07) introduces a separate `tasks.transcript`
// procedure — not bundled here.
export interface TaskDetail {
  id: number;
  agentName: string | null;
  sessionId: string;
  prompt: string;
  status: string | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  model: string | null;
  taskType: string | null;
  parentTaskId: number | null;
  channel: string | null;
  channelChatId: string | null;
  channelMessageId: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  resultMarkdown: string | null;
  resultMarkdownTruncated: boolean;
}

// T09 — wire shape returned by `analytics.dailyCost`.
// Without `groupBy`, every row carries `key: null`; with `groupBy`, `key`
// is the agentName / channel / model bucket. NULL DB values surface as
// `null` (e.g. orphan task → agent name `null`; row with no `model`
// recorded → `null`). Daily aggregate filters mirror the v1 `v_cost_daily`
// view: `status = 'done' AND cost_usd IS NOT NULL`.
export interface DailyCostPoint {
  day: string; // 'YYYY-MM-DD'
  key: string | null;
  costUsd: number;
  taskCount: number;
}

// T09 — wire shape returned by `analytics.summary`. Adds `topModels`
// vs the v1 ARCH §4.5 sketch so the spend-per-model bar chart can read
// straight from this payload (one tRPC call per page render rather than
// three). Floating-point invariant: when `totalTasks === 0`,
// `avgCostPerTask === 0` (never NaN — the wire format would lose it).
export interface CostSummaryAgentRow {
  agentName: string | null;
  costUsd: number;
  taskCount: number;
}

export interface CostSummaryModelRow {
  model: string | null;
  costUsd: number;
  taskCount: number;
}

export interface CostSummary {
  window: "24h" | "7d" | "30d";
  since: string; // ISO datetime string echoed from SQLite
  totalCostUsd: number;
  totalTasks: number;
  avgCostPerTask: number;
  topAgents: CostSummaryAgentRow[];
  topModels: CostSummaryModelRow[];
}

// T10 — wire shape returned by `agents.memory({ name })`. Reads
// `<CLAUDE_HOME>/projects/<projectSlug(projectDir)>/memory/MEMORY.md`
// (untrusted markdown — same XSS sanitization as `tasks.result_summary`)
// plus the directory listing of sibling `*.md` files.
//
// Sentinels (no markdown body served):
// - `dirMissing: true` — the agent's memory directory is absent
//   entirely (legitimate: agent has never recorded memory yet, or
//   the daemon ran on a different host).
// - `fileMissing: true` — directory exists but `MEMORY.md` is
//   missing. `files` may still list per-topic notes.
// - `fileTooLarge: true` — `MEMORY.md` exceeds the 500_000 byte cap;
//   `memoryMd` is `null` and `fileBytes` reports the actual size.
//   The user can open the file directly via `dirPath`.
//
// `memoryMdTruncated: true` would only fire when the file is exactly
// at the byte boundary; the `fileTooLarge` branch handles anything
// bigger by returning no content. Kept on the wire for parity with
// `TaskDetail.resultMarkdownTruncated` so the UI can banner the cap
// uniformly across surfaces.
export interface AgentMemory {
  projectDir: string;
  dirPath: string;
  dirMissing: boolean;
  fileMissing: boolean;
  fileTooLarge: boolean;
  fileBytes: number;
  memoryMd: string | null;
  memoryMdTruncated: boolean;
  files: string[];
}

// T07 — wire shape returned by `tasks.transcript`. Reads the Claude Code
// JSONL session file at `~/.claude/projects/<slug>/<session_id>.jsonl`
// (slug = projectDir with `/` → `-`) and returns parsed turns.
//
// Sentinels (no turns served):
// - `fileMissing: true` — JSONL not on disk (orphan / different host /
//   deleted).
// - `fileTooLarge: true` — file exceeds the 5 MB cap; user can open the
//   file directly via `filePath`.
//
// `truncated: true` means the file fits but the parsed turn count
// exceeded `MAX_TURNS_PER_TRANSCRIPT` and the most-recent N were kept.
// `filePath` is always populated for debug — even on the missing path
// the user gets a useful pointer.
export interface TaskTranscript {
  filePath: string;
  fileMissing: boolean;
  fileTooLarge: boolean;
  fileBytes: number;
  totalLines: number;
  truncated: boolean;
  // Re-exported from `src/lib/transcript.ts` — kept abstract here to
  // avoid a circular type dep.
  turns: import("../lib/transcript").TranscriptTurn[];
}

// T01 (Phase 2) — wire shape returned by `tasks.dispatch`. The daemon's
// `bridge_dispatch` MCP tool returns `{ task_id: number }` (snake_case,
// matches the SQLite `tasks.id` autoincrement). The dashboard
// normalises to camelCase before crossing the tRPC boundary so the
// client only ever sees one casing convention.
export interface DispatchResult {
  taskId: number;
}

// T03 (Phase 2) — wire shape returned by `tasks.kill`. `ok` is always
// true on a non-throw return; the procedure throws `NOT_FOUND` for an
// unknown id and the various MCP error codes for transport / daemon
// failures. `alreadyTerminated` distinguishes the two non-error paths:
//
//   alreadyTerminated=false → the dashboard saw the task as
//     pending/queued/running/etc. and successfully called bridge_kill.
//   alreadyTerminated=true  → either (a) the dashboard saw the task in
//     a terminal status before calling MCP (no-op), or (b) the daemon
//     reported "no running task / already terminated" (race window) —
//     in both cases the user's intent (the task is dead) is satisfied.
export interface KillResult {
  ok: true;
  alreadyTerminated: boolean;
}

// T06 (Phase 2) — wire shape returned by `loops.approve` and
// `loops.reject`. Same idempotency contract as `KillResult`:
//
//   alreadyFinalized=false → the dashboard saw `pending_approval=true`
//     and successfully called the daemon's MCP tool.
//   alreadyFinalized=true  → either (a) the row's pending_approval was
//     already false at lookup (server-side check), or (b) the daemon
//     reported "already approved/rejected/finalized" via MCP_RPC_ERROR
//     (multi-channel race) — both cases mean the loop is resolved and
//     the user's intent is satisfied.
//
// Two distinct types (vs one shared) so a future per-mutation
// extension (e.g. echoing iteration count) doesn't ripple across both
// procedures.
export interface LoopApproveResult {
  ok: true;
  alreadyFinalized: boolean;
}

export interface LoopRejectResult {
  ok: true;
  alreadyFinalized: boolean;
}

// P3-T1 — wire shape returned by `loops.list`. Curated subset of the
// vendored `loops` table (`src/db/schema.ts`) — column set chosen to
// keep `/loops` table rendering self-sufficient (status badge, agent
// link, iter progress, budget). `goal` is intentionally NOT included
// in the list payload (privacy precedent §c — same rule the audit log
// applies to dispatch prompts and reject reasons); detail page (T2)
// fetches the full row separately.
//
// `pendingApproval` is on the wire so the table can flag rows that
// need a human gate without a second round-trip — T4 lights up an
// "Awaiting approval" pill on those rows.
//
// `totalCostUsd` is `NOT NULL` in the daemon schema (defaults to 0);
// `maxCostUsd` is nullable (loop without a budget cap). The UI shows
// "$X.XX / $Y.YY" when capped or "$X.XX / —" when uncapped.
export interface LoopListRow {
  loopId: string;
  agent: string;
  status: string;
  loopType: string;
  currentIteration: number;
  maxIterations: number;
  totalCostUsd: number;
  maxCostUsd: number | null;
  pendingApproval: boolean;
  startedAt: string;
  finishedAt: string | null;
  finishReason: string | null;
}

export interface LoopListPage {
  items: LoopListRow[];
  // `loops.loop_id` is a TEXT primary key, so the cursor is the
  // started_at ISO string (DESC ordering = most-recent first; cursor
  // = oldest-rendered timestamp). The TEXT comparison is lexicographic
  // and ISO-8601 sorts identically to the natural date order.
  nextCursor: string | null;
}

// P2-T05 — wire shape returned by `audit.list`. Mirrors the
// dashboard-owned `audit_log` columns (T04) plus a parsed `payload`.
//
// `payload` is a best-effort `JSON.parse(payload_json)` — the audit
// writer (T04) controls serialisation, so this is normally well-formed
// JSON, but we never throw on parse failure: viewers should be able to
// surface malformed rows for forensics. When `payloadJson` is `null`
// (no payload supplied) or fails to parse, `payload` is also `null`.
//
// `createdAt` is `INTEGER NOT NULL` ms-epoch (T04 schema). We keep
// it as a number on the wire so the client can format relative times
// without timezone parsing overhead.
export interface AuditLogRow {
  id: number;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  payloadJson: string | null;
  payload: unknown | null;
  ipHash: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: number;
}

export interface AuditLogPage {
  items: AuditLogRow[];
  nextCursor: number | null;
}
