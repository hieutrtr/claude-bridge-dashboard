# Claude Bridge Web Dashboard — Product Requirements Document

> Trạng thái: Draft v1 · Owner: Hieu · Last updated: 2026-05-05
> Mục tiêu: Định nghĩa "what & why" cho web dashboard self-hosted của Claude Bridge.
> Các tài liệu liên quan: `ARCHITECTURE.md` (technical), `IMPLEMENTATION-PLAN.md` (phasing).

---

## 1. Vision & Value Proposition

Claude Bridge hôm nay đã giải được bài toán **"dispatch Claude Code từ Telegram"** — ai cầm điện thoại đều có thể giao task cho một agent đang chạy trên máy local. Nhưng Telegram chỉ tốt cho dispatch nhanh và nhận notification; nó kém ở mọi thứ cần *nhìn rộng* (so sánh cost giữa các agent, debug một loop đang stuck, đọc transcript dài, lập lịch định kỳ phức tạp). Web dashboard ra đời để bổ sung **bề rộng và độ sâu** cho Bridge: một UI đẹp, dark-first, self-hosted-by-default, mở thẳng từ máy local hoặc qua tunnel, cho phép user *thấy toàn bộ trạng thái, hành động không cần gõ command, và hiểu chi phí của mình theo thời gian thực*. Slogan nội bộ: **"Telegram để dispatch khi đang đi, dashboard để điều hành khi đang ngồi."**

---

## 2. User Personas

Bridge hiện phục vụ chủ yếu individual dev. Khi mở rộng sang dashboard, ta nhắm 4 persona — sắp xếp theo mức độ ưu tiên cho v1.

### Persona 1 — "Power User Dev" (Linh, 30, Senior Backend) — **Primary**

- **Bối cảnh:** Dùng Bridge mỗi ngày, 5–10 agent (backend, infra, scratchpad, refactor, tests). Quen tmux + CLI.
- **Pain hiện tại:**
  - Phải gõ `bridge list-agents`, `bridge history backend --limit 20`, `bridge cost --since 7d` lặp đi lặp lại.
  - Khi một loop chạy 8 iteration thì khó nhớ context — terminal scroll đi mất.
  - Không có cách so sánh "tuần này tốn bao nhiêu USD trên agent nào".
- **Jobs-to-be-done:**
  - Khi ngồi trước laptop, tôi muốn *một dashboard* hiển thị mọi agent + task running ở trang chủ.
  - Tôi muốn click vào một task để đọc transcript đầy đủ thay vì mở `result_file` bằng `cat`.
  - Tôi muốn nhìn cost chart 7d/30d và biết agent nào "đốt tiền" nhất.

### Persona 2 — "Mobile-First Dev" (Tâm, 28, Indie Hacker) — **Primary**

- **Bối cảnh:** Code chính trên Mac, nhưng 40% thời gian dispatch task qua Telegram khi ra ngoài. Có khi mở iPad ngồi café.
- **Pain hiện tại:**
  - Telegram không nhìn được transcript đầy đủ — chỉ summary.
  - Không có cách approve/reject loop từ web (đang phải dùng `/approve` trong chat).
  - Không có notification trên web; phải vào Telegram check.
- **Jobs-to-be-done:**
  - Mở Safari/Chrome trên iPad, đăng nhập 1 lần, dùng dashboard như một **app** (PWA-friendly).
  - Approve loop, dispatch task mới chỉ bằng tap.
  - Push notification (in-browser) khi task xong.

### Persona 3 — "Project Manager" (Mai, 34, PM kiêm half-tech) — **Secondary**

- **Bối cảnh:** Không code, nhưng dùng Bridge để giao task documentation, research, scrape data cho team. Sợ CLI.
- **Pain hiện tại:**
  - `bridge create-agent` phải nhớ flag `--purpose` `--model`; CLAUDE.md write ra ở đâu thì không hiểu.
  - Không có UI để xem "task nào đang pending của ai".
  - Không kiểm soát được budget — sợ Claude chạy quá USD/tháng.
- **Jobs-to-be-done:**
  - Một wizard "Create new agent" có form, validation, preview.
  - Một bảng cost với *budget cap* cảnh báo khi vượt 80%.
  - Filter task theo status + agent + date range, export CSV.

### Persona 4 — "Team Lead" (Phong, 36, Tech Lead 5 dev) — **Tertiary (v2+)**

- **Bối cảnh:** Muốn share Bridge cho team. Cần audit log, RBAC nhẹ, multi-user.
- **Pain hiện tại:**
  - Bridge hiện chỉ single-user; không biết team member nào đã dispatch task gì.
  - Không có concept user; tất cả task gán vào 1 channel.
- **Jobs-to-be-done:**
  - Magic-link invite team member.
  - Audit log: "ai đã dispatch task gì lúc nào, tốn bao nhiêu".
  - Quota per user (cost cap per month).

---

## 3. Goals & Success Metrics

Bridge dashboard thành công khi đạt các metric sau **trong 90 ngày sau v1 launch**:

| Metric | Mục tiêu | Cách đo |
|---|---|---|
| **Time-to-first-dispatch** (TTFD) — từ lúc mở dashboard lần đầu đến lúc dispatch task đầu tiên | < 90 giây | telemetry opt-in (event `dashboard.opened` → `task.dispatched`) |
| **% action không cần text command** — tỉ lệ task được tạo qua UI button/form thay vì CLI/Telegram text | ≥ 60% trong tuần thứ 4 | so sánh `tasks.channel = 'web'` vs `'telegram'` vs `'cli'` |
| **NPS** (Net Promoter Score) khảo sát trong-app | ≥ 40 | survey embed sau 14 ngày dùng |
| **Cost visibility adoption** — % user mở trang `/analytics` ≥ 1 lần/tuần | ≥ 70% | event `analytics.viewed` |
| **Loop approve latency** — thời gian trung bình từ "loop pending approval" đến "approved/rejected" qua dashboard | < 2 phút (so với 8 phút qua Telegram) | timestamp diff trong `loops` table |
| **Self-hosted setup success rate** — % user chạy `bridge dashboard --start` thành công lần đầu | ≥ 90% | exit code daemon + telemetry opt-in |

**Guiding principle:** Dashboard không phải là "thay thế CLI" mà là "khuếch đại CLI". User vẫn có thể làm mọi thứ qua CLI; dashboard chỉ làm trải nghiệm *dễ chịu hơn* cho các tác vụ visual/đa-chiều.

---

## 4. Non-Goals (v1)

Để giữ scope v1 tập trung, dashboard **KHÔNG** làm những việc sau:

1. **Không phải code editor.** Không nhúng Monaco / VS Code. Việc xem transcript là read-only; muốn sửa code thì user mở IDE.
2. **Không phải hosted SaaS.** Không có "claudebridge.app" public; mọi instance đều self-hosted, chạy local hoặc qua tunnel của user.
3. **Không có collaboration real-time** (multi-cursor, presence, comment). v1 single-user-first; team feature ở Phase 4.
4. **Không có billing / payment.** Cost chỉ để *theo dõi*, không tích hợp Stripe / API key billing.
5. **Không quản lý các Claude Code instance bên ngoài Bridge.** Chỉ thấy agent được Bridge tạo (bảng `agents` trong SQLite).
6. **Không expose dashboard ra internet by default.** Port chỉ mở khi user explicit `--with-dashboard` (xem ARCHITECTURE.md).
7. **Không thay thế Telegram bot.** Bot vẫn là channel chính cho dispatch on-the-go; dashboard bổ sung, không thay.
8. **Không support mobile native app.** PWA là đủ cho v1.

---

## 5. User Stories (Markdown checkbox)

Format: `As <persona>, I want <goal> so that <benefit>`. Mỗi story là 1 deliverable kiểm tra được.

### Power User Dev (Linh)

- [ ] As a power user, I want **một trang Agents** liệt kê tất cả agent kèm state, last_task, model, total_tasks **so that** tôi nắm toàn cảnh trong 1 cú nhìn.
- [ ] As a power user, I want **filter task by agent + status + date** **so that** tôi tìm "task failed của agent backend hôm qua" trong 5 giây.
- [ ] As a power user, I want **xem live transcript** của task đang chạy (streaming từ result_file) **so that** tôi không phải `tail -f`.
- [ ] As a power user, I want **kill task button** với confirmation **so that** tôi dừng task mà không cần `bridge kill <id>`.
- [ ] As a power user, I want **keyboard shortcut** (`g a` → agents, `g t` → tasks, `cmd+k` → command palette) **so that** workflow nhanh như Linear.
- [ ] As a power user, I want **diff view giữa 2 task result** cùng prompt **so that** so sánh kết quả 2 lần chạy.
- [ ] As a power user, I want **dark mode mặc định** với syntax highlighting cho code block trong transcript **so that** đọc đêm không chói mắt.

### Mobile-First Dev (Tâm)

- [ ] As a mobile user, I want **PWA installable** từ Safari/Chrome trên iOS/Android **so that** mở dashboard như app gốc.
- [ ] As a mobile user, I want **dispatch task qua form** (chọn agent dropdown, gõ prompt textarea, submit) **so that** không phải nhớ syntax CLI.
- [ ] As a mobile user, I want **approve/reject loop bằng 1 tap** từ list view **so that** không cần mở chat.
- [ ] As a mobile user, I want **in-browser push notification** (Web Push API) khi task complete **so that** biết ngay không cần check Telegram.
- [ ] As a mobile user, I want **layout responsive** dưới 375px **so that** dùng được trên iPhone SE.
- [ ] As a mobile user, I want **swipe-to-dismiss notification card** **so that** dọn nhanh.

### Project Manager (Mai)

- [ ] As a PM, I want **wizard "New Agent"** với 4 bước (name → project picker → purpose textarea → model select) **so that** không cần đụng terminal.
- [ ] As a PM, I want **bảng cost theo agent + tổng** với filter ngày **so that** báo cáo ngân sách hàng tuần.
- [ ] As a PM, I want **set budget cap per agent** + cảnh báo khi vượt 80% **so that** không bị bất ngờ cuối tháng.
- [ ] As a PM, I want **export CSV** cho task list / cost **so that** dán vào Google Sheets cho sếp.
- [ ] As a PM, I want **bookmark/star agent** **so that** tôi pin agent quan trọng lên đầu.
- [ ] As a PM, I want **task templates** (lưu prompt thường dùng) **so that** không phải gõ lại "scrape competitor pricing weekly".

### Team Lead (Phong) — *v2+, để tham khảo*

- [ ] As a team lead, I want **invite member qua magic link email** **so that** không phải share password.
- [ ] As a team lead, I want **audit log "who did what when"** **so that** truy vết khi có sự cố.
- [ ] As a team lead, I want **role: admin / member / viewer** **so that** kiểm soát ai được dispatch / kill / delete agent.
- [ ] As a team lead, I want **per-user monthly cost cap** **so that** ngăn ai đó "đốt" toàn bộ budget.
- [ ] As a team lead, I want **agent ownership** (mỗi agent có owner) **so that** rõ trách nhiệm.

---

## 6. Feature List (MoSCoW for v1)

Đối chiếu với CLI thật của Bridge: `create-agent`, `dispatch`, `kill`, `history`, `cost`, `loop`, `loop-approve`, `schedule-add`, `status`, v.v.

| Priority | Feature | Mapping CLI tương ứng |
|---|---|---|
| **Must** | Trang Agents (list + detail + create + delete) | `list-agents`, `create-agent`, `delete-agent`, `set-model` |
| **Must** | Trang Tasks (list + detail + transcript viewer + filter) | `history`, đọc `tasks` table |
| **Must** | Dispatch task qua form | `dispatch` |
| **Must** | Kill running task | `kill` |
| **Must** | Live status (running tasks badge, SSE updates) | `status` (poll) |
| **Must** | Cost analytics (chart 7d/30d, breakdown per agent) | `cost` |
| **Must** | Auth: password env-based hoặc magic link single-user | — (mới) |
| **Must** | Dark mode default + light mode toggle | — (UI) |
| **Should** | Loops UI (list + start + approve/reject + iteration timeline) | `loop`, `loop-status`, `loop-approve`, `loop-reject`, `loop-list` |
| **Should** | Schedules UI (list + add + pause/resume + remove) | `schedule-add`, `schedule-list`, `schedule-pause`, `schedule-resume`, `schedule-remove` |
| **Should** | Memory viewer (read-only render Auto Memory `MEMORY.md`) | `memory` |
| **Should** | Command palette (`cmd+k`) — fuzzy search action | — (UX) |
| **Should** | Web Push notification | — (mới) |
| **Should** | Doctor page (chạy `bridge doctor` → render UI) | `doctor` |
| **Could** | PWA install prompt + offline shell | — |
| **Could** | Diff view giữa 2 task result | — |
| **Could** | CSV export cho tasks + cost | — |
| **Could** | Budget cap + alert | — |
| **Could** | Task templates (saved prompts) | — |
| **Could** | Telegram message tail (xem channel inbound/outbound) | đọc `inbound_messages` / `outbound_messages` |
| **Won't (v1)** | Multi-user / RBAC / audit log | — (Phase 4) |
| **Won't (v1)** | Code editor / inline edit transcript | — |
| **Won't (v1)** | Hosted SaaS / public sign-up | — |
| **Won't (v1)** | Billing integration | — |
| **Won't (v1)** | Mobile native app (iOS/Android) | — |
| **Won't (v1)** | i18n đa ngôn ngữ (English-first; VN string sau) | — |

---

## 7. Visual Style Direction

**Tone:** Modern · Minimal · Dark-first · Tech-credible (developer audience).

**Inspiration & rationale:**
- **Linear** — typography clean, density cao mà không ngộp, keyboard-first navigation. Mượn: command palette (`cmd+k`), inline action menu, status pill design.
- **Vercel Dashboard** — graph cost / usage rất rõ ràng, dark mode chuẩn mực, deployment card layout. Mượn: cost chart style (sparkline + breakdown table), card-based agent grid.
- **Resend** — micro-interaction tinh tế, typography Inter, accent màu pastel trên nền đen sâu. Mượn: empty state minh họa, success toast.
- **Railway** — service grid + log streaming. Mượn: live transcript pane (mono font, auto-scroll, pause-on-hover).
- **shadcn/ui** — component library chuẩn để build nhanh nhưng không "AI-generated" cảm giác. Stack chính.

**Color palette (proposed):**
- Background: `#0A0A0A` (gần đen, không pure black)
- Surface: `#141414`
- Border: `#27272A`
- Text primary: `#FAFAFA`
- Text muted: `#A1A1AA`
- Accent: `#A78BFA` (Claude purple, nhẹ) hoặc `#F97316` (Bridge orange)
- Success: `#10B981`, Warning: `#F59E0B`, Danger: `#EF4444`

**Typography:** Inter (UI) + JetBrains Mono (code/transcript). Base size 14px, line-height 1.5.

**Density:** Cao như Linear, không "airy" như Notion. Table row 32px height, card padding 16px.

**Motion:** 150ms ease-out cho hover, 200ms cho route transition. Không animation kéo dài > 300ms.

---

## 8. ASCII Wireframes

### 8.1 Agents Grid (homepage)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ⌘ Claude Bridge        [Agents][Tasks][Loops][Schedules][Analytics] 🌙 │
├─────────────────────────────────────────────────────────────────────────┤
│  Agents (5 active · 2 idle)              [+ New agent]   [⌘K]           │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐      │
│  │ ● backend        │  │ ● frontend       │  │ ○ scratchpad     │      │
│  │   my-api         │  │   my-ui          │  │   playground     │      │
│  │   sonnet · $4.21 │  │   opus · $12.04  │  │   haiku · $0.18  │      │
│  │   12 tasks · 2h  │  │   8 tasks · 30m  │  │   3 tasks · 2d   │      │
│  │   [▶ Dispatch]   │  │   [▶ Dispatch]   │  │   [▶ Dispatch]   │      │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘      │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐                             │
│  │ ● infra          │  │ ● refactor       │                             │
│  │   k8s-cluster    │  │   legacy-py      │                             │
│  │   sonnet · $7.80 │  │   sonnet · $3.10 │                             │
│  │   5 tasks · 1h   │  │   22 tasks · 5m  │                             │
│  │   [▶ Dispatch]   │  │   [▶ Dispatch]   │                             │
│  └──────────────────┘  └──────────────────┘                             │
│                                                                         │
│  Recent activity                                                        │
│  ─────────────────────────────────────────────────────────────────────  │
│  ● running   #421  backend     "add pagination to /users"      2m       │
│  ✓ done      #420  frontend    "fix dark-mode toggle"          12m · $.04│
│  ✗ failed    #419  refactor    "convert utils to async"        1h · $.12 │
└─────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Task Detail (transcript + metadata)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ← Tasks / #421   "add pagination to /users"          [Kill] [Re-run]    │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─ Metadata ──────────────────┐  ┌─ Transcript (live ●) ───────────┐  │
│  │ Agent      backend          │  │ > add pagination to /users      │  │
│  │ Session    backend--my-api  │  │                                 │  │
│  │ Status     ● running        │  │ I'll add cursor-based pagina-   │  │
│  │ Started    14:02:11         │  │ tion. Let me check the current  │  │
│  │ Duration   2m 14s           │  │ /users handler first.           │  │
│  │ Cost       $0.041           │  │                                 │  │
│  │ Turns      6                │  │ [tool: Read src/users.ts]       │  │
│  │ Model      sonnet           │  │ ...                             │  │
│  │ Channel    web              │  │ [tool: Edit src/users.ts]       │  │
│  │ PID        38421            │  │ Added `limit` and `cursor`...   │  │
│  │                             │  │                                 │  │
│  │ Parent     —                │  │ [streaming...]                  │  │
│  │ Worktree   /tmp/wt-421      │  │                                 │  │
│  └─────────────────────────────┘  │ ▾ auto-scroll  ⏸ pause          │  │
│                                   └─────────────────────────────────┘  │
│  ┌─ Related ───────────────────────────────────────────────────────┐    │
│  │ Sibling tasks on this agent: #420 ✓  #418 ✗  #415 ✓             │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 8.3 Cost Analytics

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Analytics                          Last [7d ▾] [30d] [90d]   [Export ↓] │
├─────────────────────────────────────────────────────────────────────────┤
│  Total cost (7d)        Avg / day        Top agent                      │
│  $27.43                  $3.92            frontend  $12.04 (44%)         │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ $ │                                            ▆                 │   │
│  │   │                              ▆       ▆     ▆                 │   │
│  │   │                  ▆     ▅     ▆       ▆     ▆                 │   │
│  │   │     ▃     ▄     ▆     ▆     ▆       ▆     ▆                 │   │
│  │   │_____▃_____▄_____▆_____▆_____▆_______▆_____▆_______________   │   │
│  │       Mon    Tue    Wed   Thu   Fri    Sat   Sun                 │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  Breakdown by agent                                                     │
│  ─────────────────────────────────────────────────────────────────────  │
│  frontend     ████████████████████░░░░░░░░░░░░    $12.04   44%         │
│  infra        ███████████░░░░░░░░░░░░░░░░░░░░     $7.80   28%         │
│  backend      ██████░░░░░░░░░░░░░░░░░░░░░░░░░     $4.21   15%         │
│  refactor     ████░░░░░░░░░░░░░░░░░░░░░░░░░░░     $3.10   11%         │
│  scratchpad   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░     $0.28    1%         │
│                                                                         │
│  Budget: $50/mo · Used $27.43 (54%) · 12d remaining   ⚠ projected $58   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Open Questions

Cần quyết định trước khi vào phase implementation:

1. **Auth model — magic link hay password env?** Magic link cần SMTP/Resend, "đẹp" hơn nhưng add dependency. Password env `BRIDGE_DASHBOARD_PASSWORD` đơn giản nhưng UX yếu. → *Đề xuất: hỗ trợ cả hai, default password env, magic link là opt-in.*
2. **Dashboard process — embed vào MCP server hay tách Next.js process?** Embed = 1 daemon, tách = scale tốt hơn. → *Sẽ giải quyết trong ARCHITECTURE.md, nghiêng về tách.*
3. **Live updates — SSE hay WebSocket?** SSE đơn giản, đủ cho one-way streaming. WS phức tạp hơn nhưng cần khi có chat-like feature. → *v1 dùng SSE.*
4. **Có nên render Markdown của transcript hay giữ raw mono?** Raw mono trung thực với CLI; render đẹp hơn nhưng có thể che lỗi format. → *Toggle, default render.*
5. **Có cần graceful degradation khi user mở dashboard mà daemon chưa start?** → *Có, hiển thị banner "Bridge daemon not running — `bridge start` to begin".*
6. **Theme switcher có nên persist per-user hay per-browser (localStorage)?** → *v1 localStorage; multi-user thì per-user.*
7. **Telegram bot có nên tự động post link "View in dashboard" sau mỗi notification?** → *Có, nếu dashboard URL được cấu hình.*
8. **Mobile PWA install prompt — show ngay hay sau N visit?** → *Sau visit thứ 3, để không phiền.*
9. **Cost data — chỉ từ `tasks.cost_usd` hay cần parse thêm từ Claude API usage?** → *v1 dùng `cost_usd` đã có; v2 thêm token breakdown.*
10. **Branding — gọi là "Claude Bridge Dashboard" hay đặt tên riêng (ví dụ "Bridge Console")?** → *Cần user feedback, default giữ "Dashboard".*

---

*End of PRD v1 draft. Review checklist: Vision ✓ · 4 Personas ✓ · Goals + 6 metrics ✓ · 8 Non-goals ✓ · 25 user stories ✓ · MoSCoW table ✓ · Visual direction ✓ · 3 ASCII wireframes ✓ · 10 open questions ✓.*
