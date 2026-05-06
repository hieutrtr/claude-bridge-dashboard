# Claude Bridge Web Dashboard — PRD v2

> Trạng thái: Draft v2 · Owner: Hieu · Last updated: 2026-05-05
> Mục tiêu: Cập nhật v1 cho **architecture pivot** — dashboard được tách thành standalone repo, distribute riêng, install qua MCP tool.
> Tài liệu liên quan: [`v1/PRD.md`](../v1/PRD.md) (vision, personas, user stories, wireframes — kế thừa nguyên), `ARCHITECTURE.md` (technical), `IMPLEMENTATION-PLAN.md` (phasing).

---

## 0. What's new in v2 (TL;DR)

v1 PRD giả định dashboard được build *trong cùng monorepo* `claude-bridge` (như `apps/web/`). Sau khi xong Phase 0 (Next.js scaffold + 12 component test pass) ta nhận ra hai vấn đề:

1. **Release cadence không match.** Daemon (CLI, MCP server, hooks) là *infrastructure* — release chậm, conservative, semver strict. Dashboard là *UI/UX surface* — iterate nhanh, có khi 1 tuần ship 3 bản. Bundle chung khiến daemon bị ép release theo nhịp UI hoặc UI bị giam theo nhịp daemon.
2. **Phần lớn user không dùng dashboard.** Power user gắn bó với Telegram + CLI; PM persona mới là ai cần web UI. Nếu mỗi `bun install` của daemon kéo theo Next.js + 200MB `node_modules` thì cost-per-install tăng vô lý cho 80% user.

**Pivot:** dashboard ra đời như một **separate repo `claude-bridge-dashboard`**, semver tag, optional install qua MCP tool `bridge_dashboard_install`. Daemon biết về dashboard *qua agent registry* — dashboard chính là một agent đặc biệt với name `dashboard`.

Vision, personas, user stories, MoSCoW, wireframes của v1 **giữ nguyên**. v2 chỉ thay đổi *delivery model* và thêm các requirement liên quan đến install/discovery/version.

---

## 1. Distribution Model (NEW)

### 1.1 Standalone repository

Dashboard sống ở repo `claude-bridge-dashboard` (đề xuất tổ chức: `github.com/<org>/claude-bridge-dashboard`). Đặc trưng:

- **License:** BSL 1.1 với conversion sang MIT sau 2 năm (giống chiến lược của Sentry/Sourcegraph). User self-host miễn phí; commercial hosted SaaS phải xin license. Daemon `claude-bridge` giữ MIT.
- **Versioning:** strict semver. Tag `vMAJOR.MINOR.PATCH`. Major bump khi schema config breaking.
- **Build artifact:** repo ship source (Next.js + Bun); user clone tag → `bun install` → `bun run build` → `bun run start`. Không ship pre-built binary cho v1; có thể thêm Docker image / single-file build trong v2.
- **Compatibility matrix:** mỗi dashboard version khai báo trong `package.json` field `claudeBridge.compat = ">=0.5.0 <1.0.0"`. Daemon refuse start nếu version không match.

### 1.2 Why a separate repo (decoupling rationale)

Bốn lý do chính, theo thứ tự sức nặng:

1. **Independent release cycle.** Dashboard có thể ship daily; daemon ship hàng tuần. Hai changelog riêng, hai release note riêng, hai semver lane riêng. User upgrade cái nào trước cũng được, miễn nằm trong compat range.
2. **Optional install — zero overhead cho non-user.** 80% user không cần web UI. Họ `bun install -g @claude-bridge/cli` → 8MB. Khi nào cần dashboard mới gọi `bridge_dashboard_install` → mới tốn thêm 200MB. Mass adoption không bị nghẽn vì bundle size.
3. **Multi-version coexistence.** Power user có thể giữ `v0.4.0` (stable) chạy production và thử `v0.5.0-beta` ở port khác cùng lúc. Mỗi version nằm ở folder riêng `~/.claude-bridge/dashboards/<version>/`.
4. **Contributor surface area sạch.** Người contribute UI không phải clone toàn bộ daemon (bao gồm SQLite migration, MCP server, daemon lifecycle). Người contribute daemon không cần biết Next.js. Hai community không trộn lẫn issue tracker.

Trade-off: hai repo phải giữ contract chặt chẽ (config schema, DB schema). Ta absorb cost này bằng cách versioning schema trong `claude-bridge` và viết integration test cross-repo (xem ARCHITECTURE.md §10).

---

## 2. New User Journey: Install Flow

Persona Tâm (Mobile-First) hoặc Mai (PM) lần đầu muốn bật dashboard. v1 yêu cầu họ phải biết về `apps/web/`, chạy `cd apps/web && bun dev`. v2 đơn giản hoá thành một MCP tool call.

### 2.1 Happy path qua bot Telegram

```
User (Telegram): "Bật web dashboard giúp tao"
Bot: [calls MCP tool] bridge_dashboard_install({ version: "latest" })
   → Bot đọc latest stable từ remote registry (github releases hoặc static manifest)
   → Bot clone repo về ~/.claude-bridge/dashboards/v0.1.0/
   → Bot chạy `bun install` (background, ~30s)
   → Bot register agent: name="dashboard", path=<install_path>, purpose="Run web dashboard"
   → Bot trả lời: "Đã cài dashboard v0.1.0. Dispatch 'start' để boot."

User (Telegram): "/dispatch dashboard start"
Bot: [bridge dispatch dashboard "start"] → spawn Next.js, bind 127.0.0.1:7878
   → Bot trả URL: "http://127.0.0.1:7878 — bookmark trên iPad cho dễ."
```

Toàn bộ flow ≤ 60 giây, zero manual config. User không biết folder ở đâu, không gõ npm/bun, không config port.

### 2.2 Power user qua CLI

```bash
bridge_dashboard_install --version v0.1.0  # explicit pin
bridge dispatch dashboard start --port 8080
bridge_dashboard_versions  # list installed + latest available
bridge_dashboard_uninstall --version v0.0.9  # cleanup old version
```

Không bắt buộc dùng MCP — CLI shell-out gọi cùng codepath.

### 2.3 Air-gapped install

Một số user dev trong môi trường không ra internet. `bridge_dashboard_install` chấp nhận flag `--from-tarball /path/to/dashboard-v0.1.0.tgz`. Tarball họ tải sẵn từ machine khác. Daemon vẫn register agent như bình thường.

---

## 3. Updated Goals & Success Metrics

Bổ sung 3 metric đo riêng cho install flow (giữ nguyên 6 metric v1):

| Metric mới | Mục tiêu | Cách đo |
|---|---|---|
| **Install success rate** — `bridge_dashboard_install` exit code 0 trên fresh machine | ≥ 95% trên macOS + Linux | telemetry opt-in, event `dashboard.install.{ok,fail}` |
| **Install-to-first-task time** — từ lúc user gõ "install dashboard" trên Telegram đến lúc dashboard render trang chủ | < 90 giây median | timestamp diff `install.started` → `dashboard.opened` |
| **Version drift rate** — % user chạy dashboard version *outside* compat range của daemon | < 5% | `dashboard.boot` event ghi version cả 2 phía |

Một số metric v1 vẫn giữ (TTFD, % action không text command, NPS, cost visibility, loop approve latency, self-hosted setup success rate) — chỉ thay phương pháp đo cho metric "self-hosted setup" để bao gồm cả install step.

---

## 4. Updated Non-Goals (v1 → v2)

Giữ 8 non-goal v1, **thêm**:

9. **Không có "dashboard registry" central server.** Manifest version mới đọc từ GitHub releases API (hoặc static JSON trên CDN). Không build infrastructure registry riêng cho v1.
10. **Không auto-update dashboard.** User phải explicit `bridge_dashboard_install --version <new>`. Auto-update phá vỡ trust model self-hosted (user phải kiểm tra release note trước).
11. **Không hỗ trợ install nhiều dashboard *cùng version, khác config* trong cùng `~/.claude-bridge/`.** Cùng version chỉ 1 install. Multi-config là Phase 4 trở đi (cần namespace).
12. **Không support dashboard chạy remote (ngoài máy của daemon).** v1 vẫn giả định cùng host. Tunneling (Tailscale, ngrok) là user concern.

---

## 5. Updated User Stories (delta vs v1)

Thêm vào v1 set, các story cho install/version management:

### Power User Dev (Linh)
- [ ] As a power user, I want **pin dashboard version** trong config để CI/test reproducible.
- [ ] As a power user, I want **list all installed dashboards** và xem cái nào default, cái nào outdated.

### Mobile-First Dev (Tâm)
- [ ] As a mobile user, I want **install dashboard chỉ bằng 1 câu chat với bot** ("bật dashboard giúp tôi").
- [ ] As a mobile user, I want **bot tự gửi URL kèm QR code** sau khi dashboard boot, để mở nhanh trên điện thoại.

### Project Manager (Mai)
- [ ] As a PM, I want **bot báo trước thời gian install** ("sẽ mất ~30 giây") để biết chờ.
- [ ] As a PM, I want **uninstall dashboard không sợ mất data** — task/agent giữ trong DB của daemon.

### Maintainer (NEW persona — *ngầm*, dev của claude-bridge)
- [ ] As maintainer, I want **publish release dashboard không cần touch daemon repo** — release pipeline riêng.
- [ ] As maintainer, I want **integration test giữa daemon `main` và dashboard `main`** chạy nightly để catch contract drift.

---

## 6. Open Questions (delta vs v1)

Bổ sung vào 10 open question v1:

11. **Manifest source — GitHub releases API hay static JSON trên CDN?** GitHub free + chuẩn nhưng rate-limit. CDN cần infra. → *Đề xuất: GitHub releases API + cache local 1h.*
12. **Install path default `~/.claude-bridge/dashboards/<version>/` — cho phép user override?** → *Có, qua flag `--path`. Default cho 95% case.*
13. **Khi user `bridge dispatch dashboard "start"`, agent có chạy `bun run start` hay command nào?** → *Sẽ define trong `package.json` field `claudeBridge.start`. Default `bun run start`.*
14. **Compat check — daemon refuse hay warn?** → *Refuse cho major mismatch, warn cho minor.*
15. **Có cần signature/checksum verify khi install?** → *v1 không (clone từ tag là đủ trust). v2 thêm sigstore.*
16. **Single-file binary build (như Bun's `--compile`) cho v2?** → *Để sau, nếu user kêu install slow.*

---

## 7. Inheritance note

Mọi feature, wireframe, visual style, MoSCoW từ v1 **vẫn áp dụng**. v2 không thay UI, không thay vision, không thay personas. Chỉ thay:

- Code location: `apps/web/` (in claude-bridge repo) → `claude-bridge-dashboard` (separate repo).
- Install model: `bun install` ở root → `bridge_dashboard_install` MCP tool.
- Lifecycle: workspace dev → standalone agent registered with daemon.
- Discovery: hardcoded path → read `~/.claude-bridge/config.json`.

Tất cả còn lại (auth, SSE, cost analytics, command palette, dark mode, Linear-inspired density, etc.) đọc trực tiếp từ [v1/PRD.md](../v1/PRD.md) §6–§9.

---

*End of PRD v2 draft. Review checklist: TL;DR pivot ✓ · Distribution model + license + versioning ✓ · 4 decoupling reasons ✓ · 3 install user journey variants ✓ · 3 new metric ✓ · 4 new non-goal ✓ · 7 new user story ✓ · 6 new open question ✓ · Inheritance pointer to v1 ✓.*
