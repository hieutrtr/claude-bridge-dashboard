// Phase 3 — fake MCP daemon for E2E tests. The dashboard's MCP pool
// (`src/server/mcp/pool.ts`) spawns this script via the
// `CLAUDE_BRIDGE_MCP_COMMAND` env var; the script reads JSON-RPC frames
// (one per line) from stdin and writes responses to stdout. Each
// recognised method mutates the same SQLite fixture the dashboard
// reads from, so a `bridge_schedule_pause` mutation flips
// `schedules.enabled=0` immediately and the next `schedules.list`
// query reflects the change.
//
// We only handle the methods the schedules-flow + loop-flow specs
// exercise — schedule add/pause/resume/remove and loop start/cancel/
// approve/reject. Everything else returns a benign JSON-RPC error so
// an unrelated mutation (e.g. `tasks.dispatch` from a stray rate-limit
// burst) doesn't crash the daemon.
//
// SQLite path comes from `BRIDGE_DB`, set by `playwright.config.ts`.

import { Database } from "bun:sqlite";

const DB_PATH = process.env.BRIDGE_DB;
if (typeof DB_PATH !== "string" || DB_PATH.length === 0) {
  process.stderr.write("[fake-mcp] BRIDGE_DB env var not set\n");
  process.exit(1);
}

const db = new Database(DB_PATH);

interface RpcRequest {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
}

interface RpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

interface RpcError {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string };
}

function send(envelope: RpcSuccess | RpcError): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function textEnvelope(text: string): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function newLoopId(): string {
  // Deterministic-ish 16-char hex; collisions are fine since each test
  // run starts from a fresh fixture DB.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function handleScheduleAdd(params: Record<string, unknown>): unknown {
  const agentName = asString(params.agent_name);
  const prompt = asString(params.prompt);
  const intervalMinutes = asNumber(params.interval_minutes);
  const name =
    asString(params.name) ?? `auto-${Date.now().toString(36).slice(-6)}`;
  if (!agentName || !prompt || intervalMinutes === null) {
    throw new Error("invalid params");
  }
  const channel = "cli";
  const result = db
    .query(
      `INSERT INTO schedules
         (name, agent_name, prompt, interval_minutes, enabled, run_count,
          consecutive_errors, channel)
       VALUES (?, ?, ?, ?, 1, 0, 0, ?)
       RETURNING id`,
    )
    .get(name, agentName, prompt, intervalMinutes, channel) as { id: number } | null;
  if (result === null) throw new Error("insert failed");
  return textEnvelope(`Schedule #${result.id} created`);
}

function lookupScheduleId(nameOrId: string): number | null {
  const numeric = Number(nameOrId);
  if (Number.isInteger(numeric) && numeric > 0) {
    const row = db
      .query("SELECT id FROM schedules WHERE id = ? LIMIT 1")
      .get(numeric) as { id: number } | null;
    if (row) return row.id;
  }
  const byName = db
    .query("SELECT id FROM schedules WHERE name = ? LIMIT 1")
    .get(nameOrId) as { id: number } | null;
  return byName ? byName.id : null;
}

function handleSchedulePause(params: Record<string, unknown>): unknown {
  const target = asString(params.name_or_id);
  if (target === null) throw new Error("invalid params");
  const id = lookupScheduleId(target);
  if (id === null) throw new Error(`schedule ${target} not found`);
  db.run("UPDATE schedules SET enabled = 0 WHERE id = ?", [id]);
  return textEnvelope(`Schedule #${id} paused`);
}

function handleScheduleResume(params: Record<string, unknown>): unknown {
  const target = asString(params.name_or_id);
  if (target === null) throw new Error("invalid params");
  const id = lookupScheduleId(target);
  if (id === null) throw new Error(`schedule ${target} not found`);
  db.run("UPDATE schedules SET enabled = 1 WHERE id = ?", [id]);
  return textEnvelope(`Schedule #${id} resumed`);
}

function handleScheduleRemove(params: Record<string, unknown>): unknown {
  const target = asString(params.name_or_id);
  if (target === null) throw new Error("invalid params");
  const id = lookupScheduleId(target);
  if (id === null) throw new Error(`schedule ${target} not found`);
  db.run("DELETE FROM schedules WHERE id = ?", [id]);
  return textEnvelope(`Schedule #${id} removed`);
}

function handleLoopStart(params: Record<string, unknown>): unknown {
  const agent = asString(params.agent);
  const goal = asString(params.goal);
  const doneWhen = asString(params.done_when);
  if (!agent || !goal || !doneWhen) throw new Error("invalid params");
  const loopId = newLoopId();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO loops
       (loop_id, agent, project, goal, done_when, loop_type, status,
        max_iterations, max_consecutive_failures, current_iteration,
        consecutive_failures, total_cost_usd, pending_approval,
        started_at, plan_enabled, pass_threshold, consecutive_passes)
     VALUES (?, ?, ?, ?, ?, 'bridge', 'running', 10, 3, 0, 0, 0, 0, ?, 0, 1, 0)`,
    [loopId, agent, "/tmp/fake-project", goal, doneWhen, now],
  );
  return { loop_id: loopId };
}

function handleLoopCancel(params: Record<string, unknown>): unknown {
  const loopId = asString(params.loop_id);
  if (loopId === null) throw new Error("invalid params");
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE loops SET status = 'cancelled', finished_at = ?, finish_reason = 'cancelled by user'
     WHERE loop_id = ?`,
    [now, loopId],
  );
  if (result.changes === 0) throw new Error(`loop ${loopId} not found`);
  return textEnvelope(`Loop ${loopId} cancelled`);
}

function handleLoopApprove(params: Record<string, unknown>): unknown {
  const loopId = asString(params.loop_id);
  if (loopId === null) throw new Error("invalid params");
  const result = db.run(
    "UPDATE loops SET pending_approval = 0 WHERE loop_id = ?",
    [loopId],
  );
  if (result.changes === 0) throw new Error(`loop ${loopId} not found`);
  return textEnvelope(`Loop ${loopId} approved`);
}

function handleLoopReject(params: Record<string, unknown>): unknown {
  const loopId = asString(params.loop_id);
  if (loopId === null) throw new Error("invalid params");
  const result = db.run(
    "UPDATE loops SET pending_approval = 0 WHERE loop_id = ?",
    [loopId],
  );
  if (result.changes === 0) throw new Error(`loop ${loopId} not found`);
  return textEnvelope(`Loop ${loopId} rejected`);
}

function dispatch(method: string, params: unknown): unknown {
  const p = asObject(params);
  switch (method) {
    case "bridge_schedule_add":
      return handleScheduleAdd(p);
    case "bridge_schedule_pause":
      return handleSchedulePause(p);
    case "bridge_schedule_resume":
      return handleScheduleResume(p);
    case "bridge_schedule_remove":
      return handleScheduleRemove(p);
    case "bridge_loop":
      return handleLoopStart(p);
    case "bridge_loop_cancel":
      return handleLoopCancel(p);
    case "bridge_loop_approve":
      return handleLoopApprove(p);
    case "bridge_loop_reject":
      return handleLoopReject(p);
    default:
      throw new Error(`method ${method} not implemented in fake-mcp`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.length === 0) continue;
    let req: RpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      process.stderr.write(`[fake-mcp] malformed line: ${line}\n`);
      continue;
    }
    const id = typeof req.id === "number" ? req.id : -1;
    const method = req.method ?? "";
    try {
      const result = dispatch(method, req.params);
      send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message },
      });
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

// Keep the event loop alive even when stdin is briefly empty.
process.stdin.resume();
