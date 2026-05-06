# Claude Bridge Web Dashboard — Technical Architecture

> Trạng thái: Draft v1 · Owner: Hieu · Last updated: 2026-05-05
> Mục tiêu: Định nghĩa **how** — stack, data model, API, transport, deploy, security.
> Tài liệu liên quan: `PRD.md` (what & why), `IMPLEMENTATION-PLAN.md` (phasing).

---

## 1. Nguyên tắc thiết kế (Design Principles)

Trước khi đi vào stack, dashboard phải tuân thủ 5 nguyên tắc tuyệt đối — bất kỳ trade-off nào dưới đây cũng phải tôn trọng các nguyên tắc này.

1. **Self-hosted first, cloud never required** — Dashboard chạy hoàn toàn local trên máy user, dùng chính `bridge.db` đang có. Không bắt buộc bất kỳ third-party cloud nào (Auth0, Vercel KV, Pusher Cloud, …) cho v1.
2. **Zero-config, zero-port-by-default** — Sau khi `bun install` & `bridge install`, dashboard *không* mở port. Chỉ khi user gõ `bridge dashboard --start` (hoặc `bridge start --with-dashboard`) thì port `127.0.0.1:7878` mới được bind. Không listen `0.0.0.0` trừ khi user explicit `--bind 0.0.0.0` (kèm warning lớn).
3. **Single source of truth = `bridge.db`** — Không tạo DB riêng cho dashboard. Mọi state (agent, task, loop, schedule, cost) đọc/ghi trực tiếp vào `~/.claude-bridge/bridge.db` (hoặc `$CLAUDE_BRIDGE_HOME/bridge.db`). Dashboard chỉ thêm bảng `users`, `sessions_web`, `audit_log`.
4. **Re-use bridge CLI as command bus** — Mọi action mutation (dispatch, kill, approve loop, …) gọi lại CLI hiện hữu (`bridge dispatch …`) qua child process *hoặc* import direct module — không duplicate business logic. Dashboard là một **UI surface mới** trên cùng một engine, không phải engine mới.
5. **Type-safe end-to-end** — TypeScript từ DB → tRPC → React. Không có HTTP REST endpoint thủ công, không có `any`.

---

## 2. Tech Stack Final Picks

| Layer | Pick | Tại sao (3 dòng) |
|---|---|---|
| Framework | **Next.js 15 App Router** | (a) React Server Components giảm bundle size cho dashboard local (mục tiêu < 200 KB JS first load); (b) file-based routing + layout nesting hợp với cấu trúc `/agents/[name]/tasks/[id]`; (c) cộng đồng + ecosystem shadcn/ui hỗ trợ App Router native. |
| RPC | **tRPC v11** | (a) Type-safe end-to-end không cần code-gen, schema = TypeScript file; (b) tích hợp tốt với Next.js Route Handlers + React Query; (c) procedure-based mô hình map 1-1 với CLI command (`agents.list`, `tasks.dispatch`), giảm cognitive load. |
| UI Kit | **shadcn/ui + Radix Primitives** | (a) Copy-paste components, không lock vendor (chỉ vendor `npm i`), full control source; (b) accessibility (WAI-ARIA) sẵn từ Radix, đỡ phải re-implement; (c) match aesthetic Linear / Vercel mà PRD nhắm tới (dark-first, neutral palette). |
| Styling | **Tailwind CSS v4** | (a) Utility-first đồng bộ với shadcn/ui; (b) v4 native CSS engine, không cần PostCSS pipeline phức tạp; (c) dark-mode token + design-token tốt cho theme switcher Phase 4. |
| ORM | **Drizzle ORM** | (a) SQL-first, schema TypeScript thuần, không hidden magic; (b) hỗ trợ `bun:sqlite` + `better-sqlite3` + Postgres cùng một schema (migration path lên Postgres ở v2); (c) bundle nhỏ (≈ 7 KB), zero codegen step. |
| Database | **SQLite (reuse `bridge.db`) + WAL** | (a) Đã có sẵn trong Bridge, không bootstrap mới; (b) WAL mode cho phép Next.js process đọc đồng thời với daemon ghi; (c) đường nâng cấp lên Postgres rõ ràng (Drizzle abstraction) khi multi-user thật sự cần. |
| Live updates | **SSE (Server-Sent Events)** | (a) Đơn-hướng (server → browser) đủ cho status update, không cần WebSocket bi-directional; (b) chạy trên HTTP/1.1, không cần upgrade handshake → tunnel-friendly (cloudflared, ngrok pass-through); (c) auto-reconnect built-in trong `EventSource`, code client < 30 dòng. |
| Auth | **Magic-link (Resend) + Password (env)** | (a) Self-hosted: env-based password (single-user) là default zero-config; (b) Multi-user (Phase 4): magic-link via Resend API (free tier 3000/month đủ cho team < 10 người); (c) JWT cookie httpOnly + SameSite=Lax, không lưu session DB cho v1. |
| Charts | **Recharts** + **shadcn chart wrapper** | (a) Tree-shake friendly, declarative API React-y; (b) đã có wrapper trong shadcn nên đồng bộ theme token; (c) đủ cho line/bar/area chart cost analytics, không cần D3 raw. |
| Validation | **Zod v3** | (a) Đã là dependency của Bridge (`grammy` + tRPC dùng Zod); (b) inferType giữ DRY giữa form schema + API contract; (c) error message i18n-able. |
| Runtime | **Bun (server) / Node-compatible (build artifact)** | (a) Đồng bộ với Bridge — không thêm runtime mới; (b) Bun chạy được Next.js từ v14, build production ra Node-compatible standalone; (c) Bun's bundled SQLite share file lock với daemon dùng `bun:sqlite`. |
| Test | **Bun test + Playwright** | (a) Bun test cho unit/tRPC procedure (dùng chung infra Bridge); (b) Playwright cho E2E happy path; (c) không thêm Jest/Vitest. |

**Stack đã loại** (và lý do):
- ❌ **Remix / SvelteKit** — Cộng đồng shadcn nhỏ hơn, ít template starter cho dark-first dashboard.
- ❌ **GraphQL (Apollo, urql)** — Overkill cho single-app, type safety yếu hơn tRPC khi không có codegen.
- ❌ **Pusher / Ably / Supabase Realtime** — Vi phạm nguyên tắc "no third-party cloud required".
- ❌ **WebSocket (raw `ws`)** — Cần handshake upgrade, khó pass qua reverse-proxy / tunnel mặc định, overkill khi flow chỉ server→client.
- ❌ **Prisma** — Bundle to (~30 MB Prisma engine binary), startup chậm, runtime overhead cao cho local app.

---

## 3. Data Model (ER Diagram ASCII)

Dashboard **không tạo bảng mới cho domain entity** (Agent/Task/Loop/Schedule) — chỉ thêm **3 bảng** cho web layer (`users`, `web_sessions`, `audit_log`). Diagram dưới đây gộp cả core schema (đang có) + web schema (sẽ thêm).

```
┌──────────────────────────┐         ┌──────────────────────────┐
│        agents            │         │          users           │
│ ──────────────────────── │         │ ──────────────────────── │
│ name (PK)                │         │ id (PK, uuid)            │
│ project_dir (PK)         │         │ email (UNIQUE)           │
│ session_id (UNIQUE)──────┼──┐      │ display_name             │
│ purpose, model, state    │  │      │ role  ('owner'|'member') │
│ total_tasks, last_task_at│  │      │ password_hash (nullable) │
└──────────────────────────┘  │      │ magic_token, magic_exp   │
                              │      │ created_at, last_login   │
                              │      └────────────┬─────────────┘
                              │                   │
                              │                   │  user_id
                              ▼                   ▼
┌──────────────────────────────────────────────────────────────┐
│                          tasks                               │
│ ──────────────────────────────────────────────────────────── │
│ id (PK, autoinc)                                             │
│ session_id (FK → agents.session_id, ON DELETE CASCADE)       │
│ prompt, status, position, pid                                │
│ result_file, result_summary, cost_usd, duration_ms           │
│ num_turns, exit_code, error_message, model                   │
│ task_type ('standard'|'loop'|'schedule')                     │
│ parent_task_id (FK → tasks.id, self-ref)                     │
│ channel ('cli'|'telegram'|'web'|'slack'|'discord')           │
│ channel_chat_id, channel_message_id                          │
│ user_id  (NEW: FK → users.id, nullable cho legacy)           │
│ created_at, started_at, completed_at, reported               │
└─────────────┬────────────────────────────────────────────────┘
              │
              │ task_id
              ▼
┌──────────────────────────┐         ┌──────────────────────────┐
│      loops               │         │      schedules           │
│ ──────────────────────── │         │ ──────────────────────── │
│ loop_id (PK)             │         │ id (PK, autoinc)         │
│ agent, project, goal     │         │ name + agent_name (UNIQ) │
│ done_when, status        │         │ prompt                   │
│ current_iteration        │         │ interval_minutes / cron  │
│ total_cost_usd           │         │ run_once, enabled        │
│ pending_approval         │         │ run_count, last_error    │
│ plan, plan_enabled       │         │ last_run_at, next_run_at │
│ channel, user_id         │         │ channel, user_id         │
└──────────┬───────────────┘         └──────────────────────────┘
           │
           │ loop_id
           ▼
┌──────────────────────────┐         ┌──────────────────────────┐
│   loop_iterations        │         │     web_sessions         │
│ ──────────────────────── │         │ ──────────────────────── │
│ id (PK, autoinc)         │         │ id (PK, jwt-jti)         │
│ loop_id (FK)             │         │ user_id (FK → users)     │
│ iteration_num            │         │ created_at, expires_at   │
│ task_id, prompt          │         │ user_agent, ip_hash      │
│ result_summary           │         │ revoked_at               │
│ done_check_passed        │         └──────────────────────────┘
│ cost_usd, status         │
│ started_at, finished_at  │
└──────────────────────────┘

┌──────────────────────────┐         ┌──────────────────────────┐
│      audit_log           │         │   notifications (existing)│
│ ──────────────────────── │         │ ──────────────────────── │
│ id (PK, autoinc)         │         │ id, task_id, channel     │
│ user_id (FK → users)     │         │ chat_id, message, status │
│ action  (TEXT)           │         │ created_at, sent_at      │
│ resource_type, resource_id│         └──────────────────────────┘
│ payload (JSON)           │
│ ip_hash, user_agent      │
│ created_at               │
└──────────────────────────┘
```

**Cost view** — Không tạo bảng `costs` mới; tổng hợp on-the-fly bằng SQL view:

```sql
CREATE VIEW IF NOT EXISTS v_cost_daily AS
  SELECT date(completed_at) AS day,
         session_id,
         SUM(cost_usd) AS cost_usd,
         COUNT(*) AS n_tasks
    FROM tasks
   WHERE status = 'done' AND cost_usd IS NOT NULL
   GROUP BY day, session_id;
```

Drizzle khai báo view bằng `sqliteView` để tRPC procedure `analytics.dailyCost` query type-safe.

---

## 4. API Surface — tRPC Procedures

API tổ chức thành **6 router** mirror các CLI command group. Mỗi procedure chú thích `query` / `mutation` / `subscription` (SSE).

### 4.1 `agents.*`

```ts
agents.list()              // query → Agent[]
agents.get({ name })       // query → Agent | null
agents.create({ name, projectDir, purpose, model })   // mutation → Agent
agents.delete({ name })    // mutation → { ok: true }
agents.setModel({ name, model })  // mutation
agents.memory({ name })    // query → { memoryMd: string, files: string[] }
agents.status()            // query → { agents: Agent[], runningTasks: Task[] }
agents.stream()            // subscription (SSE) → AgentStateChange events
```

### 4.2 `tasks.*`

```ts
tasks.list({ sessionId?, status?, limit?, cursor? })   // query → paged
tasks.get({ id })                                       // query → Task & { transcript? }
tasks.dispatch({ agentName, prompt, model? })           // mutation → { taskId }
tasks.kill({ id })                                      // mutation
tasks.transcript({ id })   // query → { lines: TranscriptLine[] } (read result_file)
tasks.history({ agentName, limit })   // query
tasks.stream({ sessionId? })  // subscription (SSE) → TaskStatusChange + log lines
tasks.retry({ id })           // mutation → re-dispatch with same prompt
```

### 4.3 `loops.*`

```ts
loops.list({ status? })
loops.get({ loopId })            // includes iterations[]
loops.start({ agent, goal, doneWhen, maxIterations, maxCostUsd })
loops.cancel({ loopId })
loops.approve({ loopId })
loops.reject({ loopId, reason? })
loops.history({ agent? })
loops.stream({ loopId })         // subscription
```

### 4.4 `schedules.*`

```ts
schedules.list()
schedules.add({ name, agentName, prompt, interval | cron, runOnce? })
schedules.remove({ id })
schedules.pause({ id })
schedules.resume({ id })
schedules.runNow({ id })         // mutation, debug aid
```

### 4.5 `analytics.*`

```ts
analytics.dailyCost({ since, until, groupBy: 'agent' | 'channel' | 'model' })
analytics.summary({ window: '24h' | '7d' | '30d' })
   // → { totalCostUsd, totalTasks, avgCostPerTask, topAgents }
analytics.budget()               // query → { capUsd?, currentUsd, percent }
analytics.setBudget({ capUsd, period: 'monthly' })  // mutation
analytics.export({ format: 'csv' | 'json', since, until })  // mutation → file
```

### 4.6 `system.*`

```ts
system.health()                  // query → { db, daemon, mcp, version }
system.daemonStatus()            // query — wraps `bridge daemon-status`
system.logs({ tail: number })    // query — last N lines from daemon log
system.auditLog({ since, limit })  // query (owner-only)
auth.requestMagicLink({ email })
auth.consumeMagicLink({ token })
auth.logout()
auth.me()                        // query → User | null
```

**Authorization model (v1):**
- `owner`: full access mọi router.
- `member` (Phase 4): read-only `analytics.*`, `system.health` ; full `tasks.*` cho agent owner đã share.
- Procedure middleware `requireRole('owner')` enforce ở tRPC layer.

---

## 5. Live Updates — Lý do chọn SSE

**Yêu cầu:** Browser cần thấy `task.status`, `task.cost`, `loop.iteration`, agent state thay đổi gần real-time (≤ 1s lag).

**3 lựa chọn cân nhắc:**

| Phương án | Pro | Con | Verdict |
|---|---|---|---|
| **Polling** (React Query refetch 2s) | Đơn giản nhất, không stateful server | Tăng load DB, lag 2s, tốn pin mobile | ❌ Bỏ — Mobile persona quan trọng |
| **WebSocket** (`ws` lib) | Bi-directional, low-latency | Cần upgrade handshake, khó qua reverse proxy / tunnel default, code phức tạp hơn, không cần bi-directional | ❌ Bỏ — Overkill |
| **SSE** (`EventSource`) | HTTP/1.1 thuần, tunnel-friendly, auto-reconnect, đủ cho server→client | Single direction (nhưng đó là cái ta cần), giới hạn 6 connection / origin trên HTTP/1.1 | ✅ **Chọn** |

**Implementation pattern:**

- Node-side: tRPC v11 hỗ trợ subscription qua HTTP với SSE transport (`createSSEStreamProducer`).
- Server-side event source: SQLite **không có pub/sub native**, ta dùng **2 cơ chế bổ trợ**:
  1. **PRAGMA `wal_hook` + `BridgeBus`** — module Node-side `EventEmitter` được phát mỗi khi mutation chạy qua tRPC `mutation` procedure, các SSE subscriber nghe chung.
  2. **Polling 1s như fallback** cho mutation đến từ ngoài Next.js process (CLI dispatch trực tiếp, daemon stop hook). Polling chỉ chạy khi có ít nhất 1 SSE subscriber active → idle = 0 query.
- 6-connection limit: dồn tất cả live update qua **1 SSE stream channel-multiplexed** (`/api/stream?topics=tasks,loops,agents`), client filter theo topic.

---

## 6. Auth — Magic Link + Password Env

**Default (single-user, Phase 1–3):**
- `bridge dashboard --start` đọc `DASHBOARD_PASSWORD` từ env (hoặc `~/.claude-bridge/dashboard.env`).
- Nếu env trống → tự generate 1 password ngẫu nhiên (24 ký tự) và in ra terminal **1 lần duy nhất** kèm URL `http://127.0.0.1:7878?token=…` để user click vào trình duyệt.
- Form `/login` chỉ có 1 field `password`. Sau khi đăng nhập, set httpOnly cookie JWT (HS256, 30 ngày).
- `JWT_SECRET` cũng auto-generate vào file `~/.claude-bridge/dashboard.secret` (chmod 600).

**Multi-user (Phase 4):**
- Owner cấu hình `RESEND_API_KEY` → bật magic link.
- Endpoint `auth.requestMagicLink({ email })` tạo `magic_token` (32-byte URL-safe) + TTL 15 phút, gửi email qua Resend.
- Click link → `auth.consumeMagicLink({ token })` issue JWT cookie, ghi `users.last_login`.
- Không lưu password cho member, owner luôn fallback dùng env password.

**CSRF:**
- tRPC mutation kiểm `Origin` header phải match `BRIDGE_DASHBOARD_ORIGIN` (default `http://127.0.0.1:7878`).
- Cookie SameSite=Lax đủ ngăn cross-site form post.

---

## 7. Transport — Cùng MCP Process hay Tách Next.js?

**Đây là quyết định kiến trúc quan trọng nhất.** Đặt cạnh "no port exposed by default":

### Option A — Embed Next.js trong MCP server process

- ✅ 1 process → ít memory, 1 daemon entry duy nhất.
- ❌ MCP server hiện chạy stdio transport (Claude Code spawn) — embed HTTP server vào sẽ làm life-cycle phức tạp (Claude Code có thể restart MCP bất kỳ lúc nào).
- ❌ Build artifact lớn (Next.js standalone ≈ 50 MB) → install time tăng cho user không dùng dashboard.
- ❌ Crash của Next.js có thể kéo MCP chết theo → ảnh hưởng Telegram channel.

### Option B — Tách Next.js process, kích hoạt qua CLI

- ✅ MCP server giữ nguyên footprint (zero impact cho user không dùng dashboard).
- ✅ Dashboard chỉ install dependencies khi user opt-in (`bridge dashboard --install`).
- ✅ Crash isolation: dashboard chết → daemon + MCP + Telegram vẫn sống.
- ✅ Khớp 100% với nguyên tắc "no port exposed by default" — dashboard process không tồn tại nếu user không gọi.
- ❌ 2 process → duplicate config load, cần share file lock cho `bridge.db` (đã có WAL).

### **Verdict: Option B — Tách process.**

**Lifecycle:**
- `bridge dashboard --install` — `bun install` deps trong subdir `dashboard/` (lazy install).
- `bridge dashboard --start [--port 7878] [--bind 127.0.0.1]` — spawn Bun + Next.js standalone, register vào tmux session `bridge-dashboard`, ghi PID `~/.claude-bridge/dashboard.pid`.
- `bridge dashboard --stop` — kill PID + remove tmux session.
- `bridge dashboard --status` — show port, uptime, last error.
- `bridge start --with-dashboard` — convenience: `bridge start && bridge dashboard --start`.
- `bridge daemon-status` (existing) thêm field `dashboard: { running, port, pid }`.

**File layout:**
```
claude-bridge/
├── src/                  # Bridge core (existing)
└── dashboard/            # NEW — Next.js project, optional install
    ├── package.json      # depends on workspace ../src for shared types
    ├── app/
    ├── server/trpc/
    └── drizzle/
```

`dashboard/` là một workspace package (Bun workspace), không phải repo riêng — share `src/types.ts` + `src/data/db.ts` qua import path.

---

## 8. Deploy

### Local (default)

`bridge dashboard --start` → `127.0.0.1:7878`. User mở `http://localhost:7878` trong browser. 0 cấu hình.

### Cloudflared tunnel (optional, mobile access)

```bash
bridge dashboard --start --tunnel cloudflare
# → Spawn `cloudflared tunnel --url http://127.0.0.1:7878`
# → In ra URL trycloudflare.com, embed vào QR code in terminal
```

User scan QR → mở trên iPad/iPhone → magic link / password đăng nhập. Cloudflared là binary user tự cài (Bridge chỉ *gọi*, không bundle).

### Docker Compose (multi-user team)

```yaml
# docker-compose.dashboard.yml (provided in repo)
services:
  bridge-dashboard:
    build: ./dashboard
    ports: ["127.0.0.1:7878:3000"]
    volumes:
      - ~/.claude-bridge:/data
    environment:
      DASHBOARD_PASSWORD: ${DASHBOARD_PASSWORD}
      RESEND_API_KEY: ${RESEND_API_KEY:-}
      BRIDGE_DB_PATH: /data/bridge.db
```

Note: Compose không spawn `claude` CLI (vì cần host filesystem + auth). Compose chỉ chạy dashboard layer, dispatch vẫn gọi qua RPC ngược về host daemon (Phase 4 work).

---

## 9. Observability

- **Logs:** Pino structured logger ghi `~/.claude-bridge/dashboard.log` (rotate 10 MB × 5). Log level set qua `BRIDGE_LOG_LEVEL`.
- **Metrics:** `/api/internal/metrics` (owner-only) trả Prometheus text:
  - `bridge_dashboard_request_total{route,status}`
  - `bridge_dashboard_request_duration_ms{route}` (histogram)
  - `bridge_db_query_duration_ms{query}` (histogram)
  - `bridge_sse_active_clients` (gauge)
- **Cost tracking** đã sẵn trong `tasks.cost_usd` — dashboard chỉ render. View `v_cost_daily` cho query nhanh.
- **Error tracking:** Không tích hợp Sentry mặc định (vi phạm self-hosted-first). User có thể opt-in `SENTRY_DSN` env.

---

## 10. Security

| Threat | Mitigation |
|---|---|
| **CSRF** | Origin header check ở tRPC middleware; cookie SameSite=Lax; mutation luôn dùng POST. |
| **Brute-force login** | Rate-limit `/auth/*` route: 5 req/phút/IP (in-memory token bucket). Sau 5 lần fail consecutive → cooldown 15 phút. |
| **Secret leakage** | `JWT_SECRET`, `DASHBOARD_PASSWORD`, `RESEND_API_KEY` chỉ đọc từ env / file `chmod 600`. Không log secret (Pino `redact: ['authorization', 'cookie', 'password']`). |
| **SQL injection** | Drizzle prepared statement; không string-concat SQL. |
| **XSS** | React escape default; transcript render bằng `react-markdown` + sanitize HTML allowlist (`rehype-sanitize`). |
| **Public exposure misuse** | Default bind `127.0.0.1`. `--bind 0.0.0.0` in cảnh báo đỏ + yêu cầu confirm. Khi tunnel, force require non-default password (block default-generated random nếu tunnel mode bật). |
| **Audit log** | Mọi mutation ghi `audit_log(user_id, action, resource_type, resource_id, payload, ip_hash, ua, created_at)`. Owner xem qua `/admin/audit`. Hash IP (SHA-256 + per-install salt) để giữ privacy. |
| **Permission relay abuse** | Approve/reject permission qua dashboard cũng đi qua existing `permissions` table — kế thừa security model hiện hữu. |

---

## 11. Performance Budgets

- First Load JS (gzipped): **< 200 KB** trên `/agents` (landing).
- Time to Interactive (Chrome, M1 local): **< 1.0s**.
- SSE end-to-end latency (status change → DOM update): **< 1.5s** (p95).
- DB query p95: **< 50ms** (tasks.list with 10k rows, paged 50).
- Memory footprint (Node-side): **< 250 MB** RSS idle, **< 400 MB** với 50 SSE clients.

---

## 12. Open Architectural Questions

1. **Dashboard có nên embed `claude` CLI binary hay vẫn shell out?** — V1: shell out (simpler, mirror CLI behavior). V2 cân nhắc khi cần real-time stream.
2. **Migration lên Postgres khi nào?** — Đề xuất: khi >5 concurrent web user hoặc DB > 5 GB. Drizzle abstraction giữ khả năng đó.
3. **PWA / offline mode?** — Out of scope v1; revisit Phase 5.
4. **Mobile native shell (Tauri / Capacitor)?** — Out of scope; dashboard responsive đã đủ cho iPad use-case.

---

> Tài liệu này là **kế hoạch kỹ thuật** — không lock 100%. Mỗi pick có thể thay đổi nếu spike (Phase 0) phát hiện vấn đề. Mọi thay đổi cần ghi ADR vào `docs/web-dashboard/adr/`.
