# Claude Bridge Web Dashboard — Technical Architecture v2

> Trạng thái: Draft v2 · Owner: Hieu · Last updated: 2026-05-05
> Mục tiêu: Định nghĩa **how** sau pivot — repo split, discovery protocol, MCP tool design, agent integration.
> Tài liệu liên quan: [`v1/ARCHITECTURE.md`](../v1/ARCHITECTURE.md) (stack, data model, API surface — kế thừa nguyên), `PRD.md` (what & why), `IMPLEMENTATION-PLAN.md` (phasing).

---

## 0. What changed vs v1

v1 giả định dashboard sống trong cùng repo `claude-bridge` dưới `apps/web/`, build và release chung. v2 tách dashboard ra repo riêng (`claude-bridge-dashboard`), distribute qua MCP tool, đăng ký vào daemon như một agent đặc biệt.

**Sections kế thừa nguyên từ v1, không lặp lại:**
- §1 Design Principles 1–5 (self-hosted first, zero-port-by-default, single source of truth, re-use bridge CLI, type-safe end-to-end)
- §2 Tech Stack (Next.js 15 / tRPC v11 / shadcn/ui / Tailwind v4 / Drizzle / SQLite-WAL / SSE / Zod / Bun)
- §3 Data Model (chỉ thêm bảng `users`, `web_sessions`, `audit_log`; reuse `bridge.db`)
- §4 API Surface (6 router tRPC: agents/tasks/loops/schedules/analytics/system)
- §5 Live Updates (SSE multiplexed)
- §6 Auth (magic-link + password env)
- §9–§11 Observability / Security / Performance Budgets

**Sections thay đổi hoặc thêm mới (chi tiết bên dưới):**
- §1 *Decoupling principle* (nguyên tắc thứ 6 — separation of release lanes)
- §7 Transport — **rewrite hoàn toàn**: repo split + discovery thay cho monorepo embed
- §8 Deploy — **rewrite hoàn toàn**: MCP tool flow thay cho `bridge dashboard --start` CLI flag
- §13 MCP Tool Design (mới) — `bridge_dashboard_install/versions/uninstall`
- §14 Agent Integration (mới) — dashboard đăng ký dưới agent name `dashboard`
- §15 Versioning & Compatibility (mới) — compat map daemon ↔ dashboard
- §16 Config Schema (mới) — `~/.claude-bridge/config.json` đầy đủ JSON

---

## 1.6 Design Principle #6 — Decoupled release lanes

Bổ sung nguyên tắc thứ 6 vào danh sách của v1:

> **Daemon và dashboard release độc lập.** Daemon tag `v0.X.Y` chỉ ràng buộc *contract* (config schema + DB schema). Dashboard tag `v0.A.B` ship UI/UX cải tiến mà không kéo daemon. Mỗi commit ở một repo phải bảo toàn compat range; nếu phá compat → bump major ở cả hai repo song song.

Hệ quả: không có "bridge release" duy nhất. Có *daemon release* và *dashboard release*. User compose chúng qua `bridge_dashboard_install`.

---

## 7. Transport — Repo Split + Discovery Protocol *(REWRITE)*

### 7.1 Hai repo, hai lifecycle

```
github.com/<org>/claude-bridge              (MIT)
   src/                       daemon, MCP, CLI, scheduler, loop
   tests/                     bun test
   package.json               bin: bridge

github.com/<org>/claude-bridge-dashboard    (BSL 1.1 → MIT after 2 years)
   src/                       Next.js app router, tRPC, drizzle
   tests/                     bun test + Playwright
   package.json               name: @claude-bridge/dashboard
                              claudeBridge.compat: ">=0.5.0 <1.0.0"
```

Daemon **không depend on dashboard**. Dashboard depend on daemon's *contract* (config schema, DB schema), không depend on daemon's source code — schema được ship qua npm package `@claude-bridge/contract` hoặc copy-vendored để tránh circular install.

### 7.2 Discovery Protocol

Khi dashboard process khởi động (Next.js boot trong agent context), nó cần biết: DB path ở đâu? Daemon còn sống không? MCP server endpoint? Câu trả lời ở **một file duy nhất**: `$CLAUDE_BRIDGE_HOME/config.json` (default `~/.claude-bridge/config.json`).

Flow:

```
Dashboard process startup
  └─► Resolve $CLAUDE_BRIDGE_HOME (env || ~/.claude-bridge)
       └─► Read config.json (sync, must exist)
            ├─► daemon.db_path           → drizzle connection
            ├─► daemon.socket            → permission relay + future RPC
            ├─► daemon.mcp_endpoint      → optional, dashboard can call MCP
            └─► dashboards[default]      → self-identify which install is current
       └─► Verify compat: dashboard.version ∈ daemon.compat_range
            └─► If mismatch: refuse start, write error to stderr + exit 2
       └─► Open SQLite WAL connection (read+write)
       └─► Bind 127.0.0.1:7878 (default)
```

Discovery hàm chính: `discoverBridgeDaemon(): BridgeContext` (file `src/lib/discovery.ts` trong dashboard repo). Trả về `{ dbPath, socket, mcpEndpoint, version, compat }`. Nếu thiếu config → throw `BridgeNotInstalledError` với message hướng dẫn user chạy `bridge install`.

### 7.3 Daemon ↔ Dashboard Communication

Hai cơ chế bổ trợ, mỗi cái một mục đích:

**(a) Shared SQLite (`bridge.db`) — chính, bidirectional state.**
- WAL mode: daemon ghi (dispatch, on-complete hook) + dashboard ghi (manual mutations từ web) song song không khoá nhau.
- Dashboard reuse Drizzle schema, không tạo bảng entity mới.
- BridgeBus pattern (v1 §5): daemon process publish events vào file `~/.claude-bridge/events.log` (append-only ndjson); dashboard tail file này cho SSE feed. Polling 1s fallback cho mutations từ ngoài.

**(b) MCP stdio (optional, dashboard-as-client) — gọi tool từ UI.**
- Khi user click "Dispatch" trong web UI, dashboard có 2 lựa chọn:
  1. Insert vào `tasks` table trực tiếp + emit event (giống v1).
  2. Spawn `bridge --mcp` stdio + send `bridge_dispatch` JSON-RPC. Cleaner — đi qua cùng surface mà bot Telegram dùng.
- v2 chọn **(2) cho mutations**, **(1) cho reads**. Lý do: mutations thường có side effect (worktree, hooks), tốt hơn nên chạy qua daemon; reads chỉ là SQL query, gọi MCP tốn round-trip không cần thiết.
- MCP endpoint: dashboard spawn child process `bridge mcp-stdio` khi cần, hoặc reuse long-lived stdio connection nếu daemon chạy trong tmux session.

Câu hỏi mở: nên dùng Unix socket cho MCP thay vì stdio? Để Phase 5 quyết.

### 7.4 Tunnel + Cloudflared (giữ nguyên v1)

Dashboard process (Next.js standalone) bind `127.0.0.1:7878`; cloudflared tunnel public. Logic không đổi vs v1 §8.

---

## 8. Deploy — MCP Tool Flow *(REWRITE)*

Thay vì `bridge dashboard --install/--start/--stop`, v2 expose 3 MCP tool. Lifecycle thuộc về daemon (như mọi agent khác), không cần CLI flags riêng.

### 8.1 Install

```
[Bot Telegram] User: "Bật dashboard"
   ↓
[Bot Claude Code] calls MCP tool:
   bridge_dashboard_install({ version: "latest" })
   ↓
[Daemon MCP server]
   1. Resolve "latest" → fetch GitHub releases manifest
   2. mkdir -p ~/.claude-bridge/dashboards/v0.1.0/
   3. git clone --depth 1 --branch v0.1.0 <repo> <path>
   4. cd <path> && bun install
   5. Verify package.json claudeBridge.compat range against daemon version
   6. Update config.json: append { version, path, default: true }
   7. Auto-register agent via internal helper:
        agents.create({ name: "dashboard", project_dir: <path>,
                        purpose: "Run web dashboard <version>" })
   8. Return { ok: true, version, path, agent: "dashboard" }
```

### 8.2 Start (qua agent dispatch, KHÔNG có CLI riêng)

```
[Bot] bridge_dispatch({ agent: "dashboard", prompt: "start" })
   ↓
[Daemon dispatcher]
   - Spawn `claude --agent dashboard --session-id dashboard--<path>
                   --worktree -p "start"`
   - Agent .md đặc biệt cho dashboard có instruction:
       "Khi prompt là 'start', chạy: bun run start.
        Khi 'stop', kill PID file. Khi 'status', cat .pid + curl health."
   - Agent process bind 127.0.0.1:7878, write PID vào ~/.claude-bridge/dashboards/<v>/dashboard.pid
   - Stop hook: nothing — dashboard là long-running, KHÔNG complete cho đến khi user kill.
```

Hệ quả: dashboard *chính là một agent task* đang chạy. `bridge status` thấy nó như một task. `bridge kill` shut down dashboard.

### 8.3 Versions & Uninstall

```
bridge_dashboard_versions()
   → { installed: [{ version, path, default, isRunning }],
       latestStable: "v0.1.0", latestBeta: "v0.2.0-beta.1" }

bridge_dashboard_uninstall({ version })
   → Kill running PID nếu match
   → rm -rf path
   → config.json: remove entry
   → agents.delete({ name: "dashboard" }) nếu version == default
```

---

## 13. MCP Tool Design *(NEW — design only, implement Phase 5)*

3 tool, tất cả ở daemon MCP server (`src/mcp/tools.ts`). Schema Zod đầy đủ, return type explicit.

```ts
bridge_dashboard_install({
  version: z.string().default("latest"),         // semver tag or "latest" or "beta"
  path: z.string().optional(),                   // override default install dir
  setAsDefault: z.boolean().default(true),
  registerAgent: z.boolean().default(true),
}) → {
  ok: boolean, version: string, path: string,
  agent?: { name: string, sessionId: string },
  warnings: string[],   // e.g. compat mismatch downgraded to warn-only
}

bridge_dashboard_versions({
  remote: z.boolean().default(true),             // fetch latest from GitHub
}) → {
  installed: Array<{
    version: string, path: string, default: boolean,
    isRunning: boolean, pid?: number, port?: number,
    installedAt: string,
  }>,
  remote?: { latestStable: string, latestBeta?: string,
             releaseUrl: string },
  daemonCompatRange: string,
}

bridge_dashboard_uninstall({
  version: z.string(),
  force: z.boolean().default(false),             // kill running process
}) → { ok: boolean, removed: string[], warnings: string[] }
```

Implementation notes (cho Phase 5):

- `install` chạy `Bun.spawn(["git", "clone", ...])` với timeout 120s; `bun install` với timeout 300s. Stream stdout về MCP client để bot có thể relay progress qua Telegram.
- Idempotent: nếu version đã installed → no-op, return `{ ok: true, warnings: ["already installed"] }`.
- `versions.remote = true` cache 5 phút trong memory để tránh spam GitHub API.
- `uninstall` không chạm `bridge.db` (DB không thuộc về dashboard install path).

---

## 14. Agent Integration *(NEW)*

Dashboard register vào `agents` table với `name = "dashboard"`. Agent .md file generate tự động bởi `bridge_dashboard_install`:

```yaml
---
name: bridge--dashboard--<version>
description: Run claude-bridge web dashboard v0.1.0
model: claude-sonnet-4-6
tools: Read, Write, Edit, Bash
---

# Dashboard Runner Agent

This agent manages the lifecycle of the claude-bridge-dashboard at
{{PATH}} (version {{VERSION}}).

## Commands you handle (via prompt):

- `start` — Run `bun run start` in the project dir. Bind to
  127.0.0.1:7878 unless DASHBOARD_PORT env is set. Write PID to
  ./dashboard.pid. Tail server log to stderr.
- `stop` — Read dashboard.pid, kill -TERM the PID, wait 5s, escalate
  to -KILL. Remove PID file.
- `status` — Cat dashboard.pid; curl http://127.0.0.1:7878/api/health.
- `restart` — stop && start.
- `logs` — tail -200 dashboard.log.

DO NOT modify source files unless prompt explicitly says "patch <file>".

## Stop hook: none

This is a long-running process; the daemon Stop hook is intentionally
omitted. Dashboard exits only on `stop` prompt or daemon shutdown.
```

Hệ quả thiết kế:
- Dashboard không có CLI surface trong daemon. Mọi tương tác đi qua agent dispatch hoặc MCP tool.
- Multi-version coexist: nếu user install `v0.1.0` và `v0.2.0`, mỗi cái có agent riêng (`dashboard--v0.1.0` vs `dashboard--v0.2.0`); chỉ `default: true` được tham chiếu bằng tên ngắn `dashboard`.

---

## 15. Versioning & Compatibility *(NEW)*

Cả hai repo dùng strict semver. Compat được khai báo phía dashboard, daemon enforce:

| Dashboard version | Required daemon | Notes |
|---|---|---|
| `0.1.x` | `>=0.5.0 <1.0.0` | First public dashboard, against pre-1.0 daemon |
| `0.2.x` | `>=0.6.0 <1.0.0` | Adds SSE multiplex; needs daemon BridgeBus events |
| `1.0.x` | `>=1.0.0 <2.0.0` | Stable contract; multi-user roles required |

Cơ chế enforce:
1. Khi `bridge_dashboard_install` chạy, đọc `package.json#claudeBridge.compat` của dashboard version, so với daemon `package.json#version`. Nếu fail → return error trừ khi `force: true`.
2. Khi dashboard process khởi động (`discovery.ts`), re-check compat. Daemon version đọc từ `config.json#daemon.version`. Mismatch → exit code 2.

Schema breaking change checklist (cho daemon contributor):
- Đổi `bridge.db` schema → bump daemon minor; dashboard major nếu drizzle schema phải đổi.
- Đổi `config.json` shape → bump daemon major.
- Đổi MCP tool signature (`bridge_dispatch`, …) → bump daemon major.

---

## 16. Config Schema *(NEW)*

File: `$CLAUDE_BRIDGE_HOME/config.json` (default `~/.claude-bridge/config.json`). JSON, validated bởi Zod schema export từ daemon.

```json
{
  "version": 1,
  "daemon": {
    "version": "0.6.2",
    "db_path": "/Users/hieu/.claude-bridge/bridge.db",
    "socket": "/Users/hieu/.claude-bridge/daemon.sock",
    "mcp_endpoint": "stdio",
    "events_log": "/Users/hieu/.claude-bridge/events.log",
    "compat_range_for_dashboard": ">=0.1.0 <1.0.0"
  },
  "agents_dir": "/Users/hieu/.claude-bridge/agents",
  "dashboards": [
    {
      "version": "0.1.0",
      "path": "/Users/hieu/.claude-bridge/dashboards/v0.1.0",
      "default": true,
      "installed_at": "2026-05-05T10:23:11Z",
      "installed_from": "github.com/org/claude-bridge-dashboard@v0.1.0"
    }
  ],
  "channels": {
    "telegram": { "enabled": true, "bot_dir": "~/projects/bridge-bot" },
    "slack":    { "enabled": false },
    "discord":  { "enabled": false }
  }
}
```

Tất cả path **absolute** (không tilde) sau khi daemon write. Dashboard discovery đọc raw — không tự expand tilde nữa, tránh ambiguity giữa hai process khác `$HOME`.

---

## 17. Migration from v1 monorepo

Phase 0 đã build dashboard scaffold trong `apps/web/`. v2 migration (Phase 0.5, đang làm trong loop này):

1. `mv apps/web/* /Users/hieu/projects/bridge-bot-ts-1/claude-bridge-dashboard/`
2. Update `package.json`: name `@claude-bridge/dashboard`, version `0.1.0`, drop workspace ref.
3. Tạo `src/lib/discovery.ts` stub (TDD — test mock fs, function read JSON).
4. Update root `claude-bridge/package.json`: bỏ `apps/*` khỏi workspaces.
5. `git init` repo mới, initial commit (không push).
6. Bot Telegram sau loop sẽ chạy `bridge_create_agent({ name: "dashboard", path: <new path>, purpose: "Run claude-bridge dashboard v0.1.0 (manual install)" })` để register agent thủ công, đợi `bridge_dashboard_install` được implement ở Phase 5.

---

## 18. Open Architectural Questions

1. **Signed releases?** — Có nên ký GPG tag dashboard repo và verify trong `bridge_dashboard_install`? Defer Phase 6.
2. **Pre-built artifact (Docker / single-file)?** — Source clone rồi `bun install` tốn bandwidth; v0.2 cân nhắc ship Docker image qua GHCR.
3. **MCP Unix socket vs stdio?** — §7.3 chừa câu hỏi. Stdio đơn giản nhưng cần spawn mỗi call; socket persistent nhưng cần daemon listener thread.
4. **Schema package shared (`@claude-bridge/contract`)?** — Để giảm vendoring, có thể publish npm package mỏng chứa Zod schema. Defer khi có phiên bản dashboard thứ hai.

---

> Mọi pick chỉ lock khi Phase 5 (MCP tool implementation) hoàn tất. Đến lúc đó nếu phát hiện friction (vd: discovery race condition, compat enforce false-positive) sẽ revise thành ARCHITECTURE v3.
