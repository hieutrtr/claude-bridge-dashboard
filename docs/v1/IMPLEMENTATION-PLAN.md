# Claude Bridge Web Dashboard — Implementation Plan

> Trạng thái: Draft v1 · Owner: Hieu · Last updated: 2026-05-05
> Mục tiêu: Định nghĩa **when & how-to-ship** — chia 5 phase, mỗi task atomic ≤ 1 ngày, có acceptance + dependencies + risk.
> Tài liệu liên quan: `PRD.md` (what & why), `ARCHITECTURE.md` (how — stack & data model).

---

## 0. Nguyên tắc phân phase

Plan này tuân thủ 4 nguyên tắc:

1. **Vertical slice trước, polish sau** — Phase 1 phải hoàn chỉnh đầu-cuối (DB → tRPC → UI → live update) cho 1 use case (xem agent + task) chứ không build lớp-lớp.
2. **Read-only trước, write sau** — Mọi mutation (dispatch, kill, approve) đều ở Phase 2+. Phase 1 không được phép gọi `bridge dispatch` từ web.
3. **Atomic task ≤ 1 ngày** — Mỗi gạch đầu dòng là một PR đóng được trong ≤ 8h. Task lớn hơn → tách nhỏ.
4. **Mỗi phase đóng được ngay cả khi phase sau bị huỷ** — Phase 1 tự nó là MVP read-only có thể release nội bộ; Phase 2 là beta team; Phase 4 là GA.

Tổng thời gian ước tính: **5–9 tuần full-time** (1 dev) hoặc **10–18 tuần part-time** (50% allocation).

---

## Phase 0 — Spike (1–2 ngày)

**Mục tiêu:** Prove rằng Next.js process có thể đọc `bridge.db` cùng lúc với daemon ghi, và embed Next.js vào lifecycle `bridge` không vỡ DX hiện hữu. Output là **PoC throwaway**, không cần đẹp.

### Tasks

- [ ] **P0-T1 — Scaffold Next.js trong monorepo** · `apps/web/` (App Router, TypeScript strict, Tailwind v4, shadcn init).
  - Acceptance: `cd apps/web && bun dev` chạy ở `:3000`, render trang `Hello`.
  - Deps: none. Risk: thấp.
- [ ] **P0-T2 — Cấu hình `package.json` workspace** · Bun workspaces, root `bun install` resolve cả `apps/web` lẫn `src/`.
  - Acceptance: `bun install` từ root tạo đầy đủ `node_modules` cho cả hai.
  - Deps: P0-T1. Risk: Bun workspace edge case với Next.js.
- [ ] **P0-T3 — Drizzle schema introspection** · Chạy `drizzle-kit introspect` trên `bridge.db` thật, sinh `apps/web/src/db/schema.ts`.
  - Acceptance: schema TS file generate xong, compile không lỗi, match 14 bảng hiện hữu.
  - Deps: P0-T1. Risk: SQLite type coercion (boolean = int, datetime = string).
- [ ] **P0-T4 — Read concurrency test (WAL mode)** · Script vừa `bridge dispatch` (write) vừa Drizzle `select * from tasks` (read) song song 30s, đếm lỗi `database is locked`.
  - Acceptance: 0 lỗi lock với `journal_mode=WAL` + `busy_timeout=5000`.
  - Deps: P0-T3. Risk: **Cao** — nếu WAL không đủ, phải fallback litestream/replica.
- [ ] **P0-T5 — tRPC v11 minimal setup** · Một procedure `agents.list` đọc DB, render ở `/agents` page.
  - Acceptance: Trang `/agents` hiển thị danh sách agent thật từ `bridge.db`.
  - Deps: P0-T3. Risk: thấp.
- [ ] **P0-T6 — `bridge dashboard --start` CLI prototype** · Lệnh mới spawn `bun --cwd apps/web start`, log PID vào `~/.claude-bridge/dashboard.pid`.
  - Acceptance: `bridge dashboard --start` mở `http://127.0.0.1:7878`; `bridge dashboard --stop` kill PID.
  - Deps: P0-T1. Risk: trung — port collision, cleanup PID khi crash.
- [ ] **P0-T7 — Tailwind v4 + shadcn baseline** · Init Tailwind v4 (CSS engine native), add shadcn registry, render 3 component thử (`Button`, `Card`, `Input`).
  - Acceptance: dark mode toggle đổi token đúng; build production không warning.
  - Deps: P0-T1. Risk: thấp.
- [ ] **P0-T8 — Decision memo** · Viết 1-page kết luận spike: WAL ổn không, Bun + Next.js ổn không, có nên tiếp tục không.
  - Acceptance: file `docs/web-dashboard/spike-notes.md` checked in, có go/no-go.
  - Deps: P0-T1..T7. Risk: thấp.

**Exit criteria Phase 0:** WAL test pass, `bridge dashboard --start` work, decision memo `GO`.

---

## Phase 1 — Read-only MVP (1–2 tuần)

**Mục tiêu:** Dashboard "xem được mọi thứ" — list agent, list task, xem transcript, xem cost chart. Không cho phép mutation. Live status qua SSE. Auth single-user env-password.

### Tasks

- [ ] **P1-T1 — Layout & navigation shell** · Sidebar (Agents, Tasks, Loops, Schedules, Cost) + topbar (search, user menu). Tailwind + shadcn `Sidebar` component.
  - Acceptance: 5 route stub render đúng, active state đổi màu.
  - Deps: P0. Risk: thấp.
- [ ] **P1-T2 — Auth: env-password middleware** · `DASHBOARD_PASSWORD` env, login form, JWT cookie httpOnly 7d.
  - Acceptance: chưa login → redirect `/login`; sai password → 401; đúng → set cookie.
  - Deps: P1-T1. Risk: trung — secret rotation, không leak vào client.
- [ ] **P1-T3 — `agents.list` + Agents grid page** · Card grid hiển thị name, project, model, last_task_at, total_tasks, status badge.
  - Acceptance: 20 agent test render < 200ms FCP, ảnh ASCII trong PRD §Wireframes match.
  - Deps: P1-T1, P0-T5. Risk: thấp.
- [ ] **P1-T4 — `agents.get` + Agent detail page** · Tab `Tasks` (default), `Memory`, `Cost`. Ở phase này chỉ implement tab Tasks.
  - Acceptance: click card từ T3 → `/agents/[name]` hiển thị 50 task gần nhất, paginated.
  - Deps: P1-T3. Risk: thấp.
- [ ] **P1-T5 — `tasks.list` + Tasks page (global)** · Bảng task toàn instance, filter theo status (queued/running/done/failed), agent, channel, date range.
  - Acceptance: 1000-row test render virtualized < 100ms scroll, filter URL-sync.
  - Deps: P1-T1. Risk: trung — performance khi DB lớn (≥ 10k task).
- [ ] **P1-T6 — `tasks.get` + Task detail page** · Header (status, cost, duration), Prompt section, Result Markdown render, metadata sidebar (turns, model, exit_code, channel).
  - Acceptance: render `result_file` < 500KB không vỡ; long prompt collapse được.
  - Deps: P1-T5. Risk: thấp — Markdown XSS đã sandbox.
- [ ] **P1-T7 — Transcript viewer** · Đọc JSONL session file Claude Code (`~/.claude/projects/.../session.jsonl`), render từng turn assistant/user/tool.
  - Acceptance: mở task running → thấy stream live của Claude Code; tool_use block render compact.
  - Deps: P1-T6. Risk: **cao** — format JSONL có thể đổi giữa các version Claude Code.
- [ ] **P1-T8 — SSE endpoint `/api/stream/tasks`** · Server-Sent Events emit task status changes, dùng SQLite `update_hook` hoặc poll 1s.
  - Acceptance: dispatch từ Telegram → dashboard cập nhật badge < 2s không reload.
  - Deps: P1-T5. Risk: trung — nhiều tab mở cùng lúc → connection pooling.
- [ ] **P1-T9 — Cost analytics page (read-only)** · 3 chart: spend theo ngày (30 ngày), spend theo agent (pie), spend theo model (bar). Recharts.
  - Acceptance: số liệu match `bridge cost` CLI output ± 0.01 USD.
  - Deps: P1-T5. Risk: thấp.
- [ ] **P1-T10 — Memory tab (read-only)** · Render markdown file `~/.claude/projects/.../memory/MEMORY.md` của agent.
  - Acceptance: file không tồn tại → empty state "Chưa có memory"; có → render đẹp.
  - Deps: P1-T4. Risk: thấp.
- [ ] **P1-T11 — Empty / error / loading states** · 3 trạng thái cho mọi route. Skeleton từ shadcn.
  - Acceptance: ngắt mạng DB → error boundary; 0 agent → "Tạo agent đầu tiên via CLI".
  - Deps: P1-T3..T10. Risk: thấp.
- [ ] **P1-T12 — Dark / light theme** · `next-themes` + Tailwind tokens, default dark.
  - Acceptance: toggle ở topbar; preference lưu localStorage; SSR không flash.
  - Deps: P1-T1. Risk: thấp.
- [ ] **P1-T13 — E2E smoke test** · Playwright: login → click agent → click task → đọc result.
  - Acceptance: chạy CI < 60s, không flaky.
  - Deps: tất cả Phase 1. Risk: trung — Playwright + Bun.

**Exit criteria Phase 1:** 13 task pass, 1 user (Hieu) dùng dashboard 1 tuần liên tục thay cho `bridge history` / `bridge cost` không nhớ CLI.

---

## Phase 2 — Actions (1–2 tuần)

**Mục tiêu:** Cho phép dashboard *mutate*: dispatch task mới, kill task, approve/reject loop step. Mỗi action gọi lại CLI hiện hữu (re-use principle).

### Tasks

- [ ] **P2-T1 — `tasks.dispatch` mutation** · tRPC procedure spawn `bridge dispatch <agent> "<prompt>"` qua child_process; trả task_id ngay khi DB row tạo.
  - Acceptance: dispatch từ web → row xuất hiện ở `tasks` table < 500ms; PID tracked.
  - Deps: Phase 1. Risk: trung — escape shell, prompt injection nếu user paste markdown lạ.
- [ ] **P2-T2 — Dispatch dialog UI** · Modal có agent selector, textarea prompt (autosize), preview cost estimate (rough), button "Dispatch".
  - Acceptance: ⌘K mở; submit → toast với link đến task detail.
  - Deps: P2-T1. Risk: thấp.
- [ ] **P2-T3 — Kill task action** · Button "Kill" trên task running → `tasks.kill` mutation → `bridge kill <task_id>`.
  - Acceptance: confirm dialog; sau khi kill, status sang `killed` < 2s.
  - Deps: P2-T1. Risk: thấp.
- [ ] **P2-T4 — Audit log table & write** · Mỗi mutation insert row vào `audit_log` (user_id, action, target, ip, ts).
  - Acceptance: 100 action ghi đầy đủ, không miss.
  - Deps: P2-T1..T3. Risk: thấp.
- [ ] **P2-T5 — Audit log viewer page** · `/audit` route hiển thị log, filter user/action/date.
  - Acceptance: render 5000 row virtualized < 100ms scroll.
  - Deps: P2-T4. Risk: thấp.
- [ ] **P2-T6 — Inline approve/reject loop step** · Button trong task detail nếu `task_type=loop` và đang chờ user. Gọi `bridge loop-approve` / `bridge loop-reject`.
  - Acceptance: approve → loop tiếp; reject với optional comment → loop dừng.
  - Deps: P2-T1. Risk: trung — race condition nếu Telegram cũng approve cùng lúc.
- [ ] **P2-T7 — Rate limit middleware** · 30 mutation / phút / user; 429 response chuẩn.
  - Acceptance: load test 50 req/s → 30 success, 20 reject 429.
  - Deps: P2-T1. Risk: thấp.
- [ ] **P2-T8 — CSRF token** · `csrf-csrf` lib, double-submit cookie pattern cho mọi mutation.
  - Acceptance: request thiếu CSRF → 403; same-origin có token → pass.
  - Deps: P2-T1. Risk: thấp.
- [ ] **P2-T9 — Permission relay UI** · Khi Claude Code yêu cầu permission (Bash, Edit), dashboard show notification + Allow/Deny button thay vì phải qua Telegram.
  - Acceptance: tool_use_pending event qua SSE → toast → click Allow → relay xong < 1s.
  - Deps: P2-T1, Phase 1 SSE. Risk: **cao** — phụ thuộc cấu trúc permission relay hiện hữu (`src/infra/permissions.ts`).
- [ ] **P2-T10 — Optimistic UI updates** · React Query optimistic mutation cho dispatch/kill, rollback nếu lỗi.
  - Acceptance: UI phản hồi tức thì; lỗi → revert + toast.
  - Deps: P2-T1..T6. Risk: thấp.
- [ ] **P2-T11 — Confirmation pattern cho destructive action** · Kill task / cancel loop yêu cầu typing tên agent.
  - Acceptance: `delete-agent` / `kill` đều có guard.
  - Deps: P2-T3. Risk: thấp.

**Exit criteria Phase 2:** Có thể chạy 1 ngày làm việc chỉ qua dashboard, không mở CLI lẫn Telegram.

---

## Phase 3 — Loop & Schedule UI (1 tuần)

**Mục tiêu:** Hai feature nâng cao của Bridge (loop & schedule) hiện chỉ accessible qua CLI dài dòng. Dashboard biến chúng thành GUI dễ dùng.

### Tasks

- [ ] **P3-T1 — `loops.list` + Loops page** · Bảng loop với agent, status (running/waiting_approval/done), iter, ngân sách còn lại.
  - Acceptance: filter status, click → detail.
  - Deps: Phase 2. Risk: thấp.
- [ ] **P3-T2 — Loop detail page** · Timeline iter, mỗi iter expand được (prompt → output → eval). Sparkline cost cumulative.
  - Acceptance: 50 iter render mượt; collapse default.
  - Deps: P3-T1. Risk: thấp.
- [ ] **P3-T3 — Start new loop dialog** · Form: agent, goal prompt, max_iter, max_cost_usd, evaluator template (dropdown).
  - Acceptance: submit → call `bridge loop`; redirect đến detail.
  - Deps: P3-T1. Risk: trung — validate evaluator config.
- [ ] **P3-T4 — Cancel loop / approve gate UI nâng cấp** · Inline ở Loop detail, không cần qua Task detail.
  - Acceptance: 1 click cancel; gate có nút Allow/Deny lớn.
  - Deps: P2-T6. Risk: thấp.
- [ ] **P3-T5 — `schedules.list` + Schedules page** · Bảng cron job (agent, cron, prompt, last_run, next_run, paused?).
  - Acceptance: cron expression format đẹp ("Mỗi ngày 9:00 sáng").
  - Deps: Phase 2. Risk: thấp.
- [ ] **P3-T6 — Schedule create form** · Agent + prompt + cron picker (dropdown preset: hourly/daily/weekly + custom).
  - Acceptance: validate cron client-side; submit → `bridge schedule-add`.
  - Deps: P3-T5. Risk: trung — cron picker UX.
- [ ] **P3-T7 — Pause / resume / delete schedule** · Inline action menu.
  - Acceptance: 1 click toggle; xác nhận trước khi delete.
  - Deps: P3-T5. Risk: thấp.
- [ ] **P3-T8 — Schedule run history** · Click row → drawer show 30 lần chạy gần nhất với link sang task detail.
  - Acceptance: render < 200ms.
  - Deps: P3-T5. Risk: thấp.
- [ ] **P3-T9 — Cost forecast** · Trên schedule create, ước lượng spend/tháng dựa trên cost trung bình các task trước.
  - Acceptance: số ước lượng ± 30% so với thực tế sau 1 tháng.
  - Deps: P3-T6. Risk: thấp.

**Exit criteria Phase 3:** PM persona (Mai trong PRD) tạo & quản lý 5 schedule không cần training CLI.

---

## Phase 4 — Polish & Multi-user (1–2 tuần)

**Mục tiêu:** Đưa dashboard từ "đủ dùng cá nhân" lên "đủ dùng team 5–10 người". Magic-link auth, RBAC, keyboard shortcut, theme polish.

### Tasks

- [ ] **P4-T1 — Magic-link auth qua Resend** · Schema `users`, gửi email magic link, verify token → set session.
  - Acceptance: email tới < 30s; link 1 lần, exp 15 phút.
  - Deps: Phase 1 auth. Risk: trung — Resend API key handling.
- [ ] **P4-T2 — User management page** · Owner invite member qua email; revoke; đổi role.
  - Acceptance: 10 user CRUD work; audit log ghi đầy đủ.
  - Deps: P4-T1. Risk: thấp.
- [ ] **P4-T3 — RBAC middleware** · 2 role: `owner`, `member`. Member không xoá agent / kill task của user khác.
  - Acceptance: 403 đúng chỗ; matrix permission tested.
  - Deps: P4-T2. Risk: trung — check exhaustive.
- [ ] **P4-T4 — Multi-user cost view** · Cost split theo user (nếu task có `user_id`); leaderboard tháng.
  - Acceptance: số match `audit_log` join `tasks`.
  - Deps: P4-T3. Risk: thấp.
- [ ] **P4-T5 — Keyboard shortcut palette (⌘K)** · cmdk-style: dispatch, jump to agent, search task.
  - Acceptance: 10 shortcut work; help dialog `?`.
  - Deps: Phase 2. Risk: thấp.
- [ ] **P4-T6 — Notification preferences** · Per-user: in-app toast, email digest, browser push (optional). Default off.
  - Acceptance: setting persist; email digest gửi 1 lần / ngày 9:00.
  - Deps: P4-T1. Risk: trung — browser push permission flow.
- [ ] **P4-T7 — Mobile responsive pass** · Mọi route work trên iPhone width 390px, sidebar collapse thành drawer.
  - Acceptance: Lighthouse mobile score ≥ 90.
  - Deps: tất cả. Risk: thấp.
- [ ] **P4-T8 — Cloudflared tunnel docs** · `bridge dashboard --tunnel` flag spawn cloudflared, log URL public.
  - Acceptance: chạy lệnh → mở được từ điện thoại 4G.
  - Deps: P4-T1 (auth bắt buộc trước khi expose). Risk: **cao** — security review trước khi merge.
- [ ] **P4-T9 — Docker Compose template** · `docker-compose.yml` cho self-hosted có persist volume `bridge.db`.
  - Acceptance: `docker compose up` chạy dashboard standalone (mode read-only nếu không mount socket daemon).
  - Deps: tất cả. Risk: trung — Bun trong Docker.
- [ ] **P4-T10 — Onboarding wizard** · Lần đầu mở dashboard: tạo agent đầu tiên qua form (call `bridge create-agent`).
  - Acceptance: 0-agent state có CTA wizard; sau wizard → grid hiện 1 agent.
  - Deps: Phase 2. Risk: thấp.
- [ ] **P4-T11 — Telemetry opt-in (anonymous)** · `bridge dashboard --telemetry` ghi page-view + feature-usage để biết tính năng nào dùng.
  - Acceptance: default OFF; UI có toggle rõ ràng; data POST đến endpoint do user kiểm soát.
  - Deps: tất cả. Risk: cao — privacy positioning của Bridge.
- [ ] **P4-T12 — Performance budget** · First-load JS < 200KB; LCP < 1.5s; TTI < 2s ở local.
  - Acceptance: Lighthouse CI fail nếu vượt budget.
  - Deps: tất cả. Risk: trung — Recharts có thể to.
- [ ] **P4-T13 — Public release docs** · README dashboard, screenshot, GIF demo, hướng dẫn `bridge dashboard --start`.
  - Acceptance: PR merge `main`; tag `v1.0-dashboard`.
  - Deps: tất cả. Risk: thấp.

**Exit criteria Phase 4:** Public announcement, 50+ external user thử trong tuần đầu.

---

## Risk Register — Top 5

| # | Risk | Probability | Impact | Mitigation |
|---|------|---|---|---|
| 1 | **SQLite contention với daemon** — Next.js read + bridge daemon write cùng `bridge.db` gây `database is locked` lúc load cao. | Medium | High | Phase 0 spike test WAL + busy_timeout. Nếu fail → litestream replica read-only DB cho web; tệ hơn → tách Postgres ở v2. |
| 2 | **Permission relay & loop approve race condition** — User approve trên web đồng thời reject trên Telegram → state inconsistent. | Medium | High | Single transaction + row-level lock SQLite (`BEGIN IMMEDIATE`); UI disable action sau khi click; idempotent CLI command. |
| 3 | **JSONL transcript format đổi giữa các version Claude Code** — P1-T7 vỡ khi update Claude Code. | High | Medium | Version-detect parser, fallback raw text view; pin Claude Code minor version trong `package.json` engines; integration test mỗi release. |
| 4 | **Self-host security do user expose port nhầm** — User chạy `--bind 0.0.0.0` trên VPS không hiểu rủi ro. | High | Critical | Default `127.0.0.1` cứng; flag `--bind` in cảnh báo đỏ + xác nhận; auth bắt buộc ON nếu non-localhost; doc nhấn mạnh tunnel thay vì expose. |
| 5 | **Scope creep từ "dashboard" → "platform"** — Stakeholder request analytics ML, billing, marketplace. | High | Medium | PRD MoSCoW cứng; Won't list explicit; mỗi request mới phải re-prioritize, không lén thêm vào phase đang làm. |

---

## Cost Estimate

### Token cost (Claude Code dùng để build dashboard)

Giả định 1 dev dùng Claude Code (Opus 4.7) làm chủ đạo, 6h coding/ngày, ~80k token in + 20k token out / ngày (cache hit ~70%).

- Phase 0 (1.5d): ~$8
- Phase 1 (10d): ~$60
- Phase 2 (10d): ~$60
- Phase 3 (5d): ~$30
- Phase 4 (10d): ~$60
- **Tổng token cost ước tính: $200–250 USD** (Opus 4.7 với prompt caching).

### Infra cost (chạy dashboard production)

- **Self-host (default):** $0 — chạy chung máy với daemon Bridge.
- **Resend (magic-link, Phase 4):** $0 trên free tier (3000 email/tháng đủ team < 50 người).
- **Cloudflared tunnel (optional):** $0 — Cloudflare miễn phí cho hobby.
- **Docker registry public image:** $0 — GHCR free cho public.
- **Tổng infra: $0/tháng** cho team < 10 người.

### Time cost (1 dev)

| Phase | Full-time | Part-time (50%) |
|---|---|---|
| Phase 0 | 1–2 ngày | 3–4 ngày |
| Phase 1 | 8–12 ngày | 16–24 ngày |
| Phase 2 | 8–12 ngày | 16–24 ngày |
| Phase 3 | 4–6 ngày | 8–12 ngày |
| Phase 4 | 8–12 ngày | 16–24 ngày |
| **Tổng** | **5–9 tuần** | **10–18 tuần** |

### Maintenance cost (sau v1)

- Bug-fix + minor update: ~2h/tuần ổn định.
- Major Next.js / Claude Code version bump: ~1 ngày/quý.
- Tổng: ~10–12 ngày/năm.

---

## Mở rộng — Sau v1 (không nằm trong plan này)

- Postgres mode cho team > 50 user.
- Plugin marketplace (custom evaluator templates).
- iOS/Android native shell wrapping web dashboard.
- AI-assisted task drafting (gợi ý prompt từ memory).

Các mục trên thuộc "Won't (v1)" trong PRD và được track riêng ở `docs/web-dashboard/v2-ideas.md` (sẽ tạo sau).

---

*End of IMPLEMENTATION-PLAN.md.*
