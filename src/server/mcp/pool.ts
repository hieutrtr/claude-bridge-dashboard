import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type McpErrorCode =
  | "MCP_CONNECTION_LOST"
  | "MCP_CONNECTION_CLOSED"
  | "MCP_BACKPRESSURE"
  | "MCP_TIMEOUT"
  | "MCP_ABORTED"
  | "MCP_SPAWN_FAILED"
  | "MCP_RPC_ERROR";

export class McpPoolError extends Error {
  readonly code: McpErrorCode;
  readonly cause?: unknown;

  constructor(code: McpErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "McpPoolError";
    this.code = code;
    this.cause = cause;
  }
}

export interface McpPoolOptions {
  /** Executable to spawn (e.g. "bun" or "bridge"). */
  command: string;
  /** Args after the command. */
  args?: readonly string[];
  /** Extra env vars merged onto `process.env`. */
  env?: Record<string, string>;
  /** Max in-flight + queued requests (default 32). */
  queueCap?: number;
  /** Per-request timeout in ms (default 15_000). */
  timeoutMs?: number;
  /**
   * Backoff schedule for spawn retries, in ms. Used in order; the last
   * value is reused for any further attempts. Default: [250, 500, 1000,
   * 2000, 4000, 8000].
   */
  backoffMs?: readonly number[];
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Override the pool default timeout (ms). */
  timeoutMs?: number;
}

/**
 * Minimal contract a mutation procedure needs from the pool. Tests inject a
 * fake (no spawn) by satisfying this shape; production wiring uses the
 * concrete `McpPool` returned by `getMcpPool()`.
 */
export interface McpClient {
  call(method: string, params: unknown, opts?: CallOptions): Promise<unknown>;
}

interface PendingCall {
  id: number;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  abortHandler: (() => void) | null;
  signal?: AbortSignal;
}

const DEFAULT_BACKOFF = [250, 500, 1000, 2000, 4000, 8000] as const;

export class McpPool {
  private readonly opts: Required<Pick<McpPoolOptions, "command" | "queueCap" | "timeoutMs">> & {
    args: readonly string[];
    env: Record<string, string>;
    backoffMs: readonly number[];
  };

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private outBuf = "";
  private state: "idle" | "starting" | "ready" | "closed" = "idle";
  private spawnPromise: Promise<ChildProcessWithoutNullStreams> | null = null;
  private backoffIdx = 0;
  /** How many child processes we've spawned over the pool's lifetime. */
  private _spawnCount = 0;
  /** Synchronously-reserved slot count, including not-yet-sent calls. */
  private slotsReserved = 0;

  constructor(opts: McpPoolOptions) {
    this.opts = {
      command: opts.command,
      args: opts.args ?? [],
      env: opts.env ?? {},
      queueCap: opts.queueCap ?? 32,
      timeoutMs: opts.timeoutMs ?? 15_000,
      backoffMs: opts.backoffMs ?? DEFAULT_BACKOFF,
    };
  }

  get spawnCount(): number {
    return this._spawnCount;
  }

  call(method: string, params: unknown, callOpts: CallOptions = {}): Promise<unknown> {
    // All gates run synchronously — N concurrent call() invocations must see
    // a consistent slotsReserved before any await suspends.
    if (this.state === "closed") {
      return Promise.reject(
        new McpPoolError("MCP_CONNECTION_CLOSED", "pool is closed"),
      );
    }
    if (this.slotsReserved >= this.opts.queueCap) {
      return Promise.reject(
        new McpPoolError(
          "MCP_BACKPRESSURE",
          `queue cap (${this.opts.queueCap}) exceeded`,
        ),
      );
    }
    if (callOpts.signal?.aborted) {
      return Promise.reject(
        new McpPoolError("MCP_ABORTED", "call aborted before send"),
      );
    }
    this.slotsReserved++;
    return this.callInner(method, params, callOpts).finally(() => {
      this.slotsReserved--;
    });
  }

  private async callInner(
    method: string,
    params: unknown,
    callOpts: CallOptions,
  ): Promise<unknown> {
    const child = await this.ensureChild();

    return new Promise<unknown>((resolve, reject) => {
      const id = this.nextId++;
      const timeoutMs = callOpts.timeoutMs ?? this.opts.timeoutMs;

      const pending: PendingCall = {
        id,
        resolve,
        reject,
        timeoutHandle: null,
        abortHandler: null,
        signal: callOpts.signal,
      };

      pending.timeoutHandle = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.cleanupPending(pending);
          reject(new McpPoolError("MCP_TIMEOUT", `call ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      if (callOpts.signal) {
        const handler = () => {
          if (this.pending.delete(id)) {
            this.cleanupPending(pending);
            reject(new McpPoolError("MCP_ABORTED", `call ${method} aborted`));
          }
        };
        pending.abortHandler = handler;
        callOpts.signal.addEventListener("abort", handler, { once: true });
      }

      this.pending.set(id, pending);

      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      try {
        child.stdin.write(frame);
      } catch (err) {
        // EPIPE / write-after-end. Surface as connection-lost so caller can retry.
        if (this.pending.delete(id)) {
          this.cleanupPending(pending);
          reject(new McpPoolError("MCP_CONNECTION_LOST", "stdin write failed", err));
        }
      }
    });
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";

    // Reject all pending with CONNECTION_CLOSED.
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      this.cleanupPending(pending);
      pending.reject(
        new McpPoolError("MCP_CONNECTION_CLOSED", "pool closed while call pending"),
      );
    }

    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private cleanupPending(p: PendingCall): void {
    if (p.timeoutHandle) clearTimeout(p.timeoutHandle);
    if (p.abortHandler && p.signal) {
      p.signal.removeEventListener("abort", p.abortHandler);
    }
  }

  private async ensureChild(): Promise<ChildProcessWithoutNullStreams> {
    if (this.state === "closed") {
      throw new McpPoolError("MCP_CONNECTION_CLOSED", "pool is closed");
    }
    if (this.child && this.state === "ready") return this.child;
    if (this.spawnPromise) return this.spawnPromise;

    this.state = "starting";
    this.spawnPromise = this.spawnChild();
    try {
      const child = await this.spawnPromise;
      return child;
    } finally {
      this.spawnPromise = null;
    }
  }

  private async spawnChild(): Promise<ChildProcessWithoutNullStreams> {
    let lastErr: unknown;
    while (this.state !== "closed") {
      try {
        const child = spawn(this.opts.command, [...this.opts.args], {
          env: { ...process.env, ...this.opts.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        this._spawnCount++;
        this.attachChild(child);

        // Wait for either spawn-success or immediate error.
        await new Promise<void>((resolve, reject) => {
          const onError = (err: unknown) => {
            child.off("spawn", onSpawn);
            reject(err);
          };
          const onSpawn = () => {
            child.off("error", onError);
            resolve();
          };
          child.once("error", onError);
          child.once("spawn", onSpawn);
        });

        this.state = "ready";
        this.backoffIdx = 0;
        return child;
      } catch (err) {
        lastErr = err;
        const delay =
          this.opts.backoffMs[
            Math.min(this.backoffIdx, this.opts.backoffMs.length - 1)
          ] ?? 1000;
        this.backoffIdx++;
        if (this.backoffIdx >= this.opts.backoffMs.length * 2) {
          // Give up after ~2× the backoff schedule worth of attempts.
          throw new McpPoolError(
            "MCP_SPAWN_FAILED",
            `failed to spawn ${this.opts.command} after retries`,
            err,
          );
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new McpPoolError("MCP_CONNECTION_CLOSED", "pool closed during spawn", lastErr);
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    this.child = child;
    this.outBuf = "";

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      // Prefix daemon stderr to make it easy to grep in dev.
      process.stderr.write(`[mcp-pool] ${chunk}`);
    });

    const onExit = () => this.onChildExit();
    child.once("exit", onExit);
    child.once("close", onExit);
    // Swallow late stdin write errors so they don't crash the process; the
    // pending-call rejection path already surfaces them.
    child.stdin.on("error", () => {});
  }

  private onStdout(chunk: string): void {
    this.outBuf += chunk;
    let nl: number;
    while ((nl = this.outBuf.indexOf("\n")) !== -1) {
      const line = this.outBuf.slice(0, nl).trim();
      this.outBuf = this.outBuf.slice(nl + 1);
      if (!line) continue;
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(line);
    } catch (err) {
      process.stderr.write(`[mcp-pool] ignoring malformed line: ${line}\n`);
      return;
    }
    if (typeof msg.id !== "number") {
      // Notification — Phase 2 dashboard has no consumers. Drop.
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return; // already timed out / aborted
    this.pending.delete(msg.id);
    this.cleanupPending(pending);
    if (msg.error) {
      pending.reject(
        new McpPoolError("MCP_RPC_ERROR", `rpc error: ${msg.error.message}`, msg.error),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private onChildExit(): void {
    if (this.state === "closed") return;

    // Reject all pending with CONNECTION_LOST.
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      this.cleanupPending(pending);
      pending.reject(
        new McpPoolError("MCP_CONNECTION_LOST", "child process exited unexpectedly"),
      );
    }

    // Drop the child so the next call() respawns.
    this.child = null;
    this.state = "idle";
  }
}

// --- Singleton factory (lazy) ---

let singleton: McpClient | null = null;

/**
 * Returns the process-wide singleton MCP client. Lazily constructed on first
 * call. Tests should construct `new McpPool(...)` directly so they don't
 * pollute the singleton, or use `__setMcpClientForTests(...)` to inject a
 * fake.
 *
 * Production wiring uses `CLAUDE_BRIDGE_MCP_COMMAND` env (space-separated
 * command + args) when set; otherwise defaults to `bridge mcp`. Note: the
 * `bridge mcp` subcommand does not yet exist in the daemon CLI as of
 * 2026-05-06 — see docs/tasks/phase-2/T12-mcp-pool.md "Daemon command gap".
 */
export function getMcpPool(): McpClient {
  if (singleton) return singleton;
  const override = process.env.CLAUDE_BRIDGE_MCP_COMMAND?.trim();
  let command: string;
  let args: string[];
  if (override) {
    const parts = override.split(/\s+/);
    command = parts[0]!;
    args = parts.slice(1);
  } else {
    command = "bridge";
    args = ["mcp"];
  }
  singleton = new McpPool({ command, args });
  return singleton;
}

/** Test-only: reset the singleton. */
export function __resetMcpPoolForTests(): void {
  singleton = null;
}

/**
 * Test-only: inject a specific client (real `McpPool` or fake). Pass `null`
 * to clear the override and let `getMcpPool()` lazily construct again. Used
 * by tRPC dispatch tests to avoid spawning a real daemon process.
 */
export function __setMcpClientForTests(client: McpClient | null): void {
  singleton = client;
}
