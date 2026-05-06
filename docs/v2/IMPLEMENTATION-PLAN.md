# Claude Bridge Web Dashboard — Implementation Plan v2

> Trạng thái: Draft v2 · Owner: Hieu · Last updated: 2026-05-05
> Mục tiêu: Cập nhật v1 plan cho **architecture pivot** (repo split, MCP-tool install, agent integration). Bookmark Phase 0 (đã DONE), thêm Phase 0.5 Migration, re-point Phase 1–4 sang repo ngoài, thêm Phase 5 mới.
> Tài liệu liên quan: [`v1/IMPLEMENTATION-PLAN.md`](../v1/IMPLEMENTATION-PLAN.md) (gốc — task list 5 phase), `PRD.md` (what & why v2), `ARCHITECTURE.md` (transport, discovery, MCP tool, config schema).

---

## 0. What's new in v2

1. **Phase 0 = DONE.** Spike pass (WAL ổn, Bun + Next.js workspace ổn, baseline render). Memo `GO`. v2 không động tới — coi như bookmark history.
2. **Phase 0.5 Migration (mới).** Tách `apps/web/` ra repo ngoài, init git, register agent `dashboard`. Phase đang chạy *trong loop hiện tại*.
3. **Phase 1–4 path re-point.** Task v1 giữ nguyên acceptance, chỉ đổi `apps/web/` → external repo + thay monorepo reference bằng cross-repo contract (config + DB schema vendor).
4. **Phase 5 (mới).** Implement `bridge_dashboard_install/versions/uninstall` ở daemon. **Out of scope loop hiện tại** — làm sau khi 0.5 ổn.

Time budget +3–5 ngày so với v1 do repo split + MCP tool work, đổi lại release cycle độc lập.

---

## 1. Nguyên tắc phân phase (cập nhật)

Kế thừa 4 nguyên tắc của v1 (vertical slice, read-only trước, atomic ≤ 1 ngày, mỗi phase đóng được) và thêm:

5. **Schema-first cross-repo contract.** Mọi thay đổi config schema (`~/.claude-bridge/config.json`) hoặc DB schema (`bridge.db`) phải được semver hoá *trước* khi code dashboard tiêu thụ. Daemon ship schema qua một file canonical (`schemas/config.v1.json`); dashboard copy-vendor hoặc consume qua npm contract package. Không cho phép dashboard "guess" field daemon chưa hứa.

---

## Phase 0 — Spike *(DONE — bookmark only)*

✅ **Trạng thái: COMPLETE** trên branch trước migration. Tất cả 8 task (P0-T1 → P0-T8) pass. Decision memo `docs/web-dashboard/spike-notes.md` checked in với verdict `GO`. Output là `apps/web/` PoC đầy đủ + 12 component test pass.

**Lý do giữ bookmark:** code Phase 0 chính là input của Phase 0.5 — ta migrate nguyên trạng sang repo mới, không re-implement. Nếu v2 abort sau migration, có thể revert về `apps/web/` từ git history (~commit Phase 0 done).

Không có task mới ở Phase 0. Skip sang Phase 0.5.

---

## Phase 0.5 — Migration (1–2 ngày, *đang làm*)

**Mục tiêu:** chuyển `apps/web/` sang external repo `claude-bridge-dashboard` (`/Users/hieutran/projects/bridge-bot-ts-1/claude-bridge-dashboard/`), init git, ghi marker để bot register agent.

### Tasks

- [x] **P0.5-T1 — Inventory v1 docs** · Move 3 doc cũ vào `docs/web-dashboard/v1/`, scaffold `v2/` skeleton.
- [x] **P0.5-T2 — PRD v2** · Distribution model + install journey + decoupling rationale (~1500 từ).
- [x] **P0.5-T3 — ARCHITECTURE v2** · Rewrite §7 Transport + §8 Deploy, thêm §13–16 (MCP tool, agent, versioning, config schema).
- [ ] **P0.5-T4 — IMPLEMENTATION-PLAN v2** *(this doc)*.
- [ ] **P0.5-T5 — Move `apps/web/` → external dir** · `git mv` hoặc `cp -r && rm -rf`, giữ structure src/tests/package.json/tsconfig.
- [ ] **P0.5-T6 — Standalone `package.json`** · name `@claude-bridge/dashboard`, drop workspace ref, thêm `claudeBridge.compat`.
- [ ] **P0.5-T7 — README + .gitignore + discovery stub** · `src/lib/discovery.ts::discoverBridgeDaemon()` đọc `~/.claude-bridge/config.json` (TDD: test trước, impl sau, throw `BridgeNotFoundError` khi miss).
- [ ] **P0.5-T8 — Cleanup claude-bridge root** · Bỏ `apps/web` khỏi root `workspaces`; verify `bun install` + `bun test` vẫn pass.
- [ ] **P0.5-T9 — Verify dashboard repo** · Trong dir mới: `bun install`, `bun test`, `bun run build` đều exit 0.
- [ ] **P0.5-T10 — Init git** · `git init && git add -A && git commit -m "initial migration"`. **Không push.**
- [ ] **P0.5-T11 — Marker file** · Ghi `MIGRATION-COMPLETE.md`: summary, verification log, suggested agent purpose, cost.

**Exit criteria:** dashboard repo build pass, git init xong, marker file đủ context cho bot register agent ở turn kế tiếp.

---

## Phase 1 — Read-only MVP (1–2 tuần) *(re-pointed)*

**Path delta vs v1:** mọi reference `apps/web/` đổi sang `<DASHBOARD_REPO>/` (ví dụ `~/projects/bridge-bot-ts-1/claude-bridge-dashboard/`). Nội dung task v1 (P1-T1 → P1-T13) **giữ nguyên** vì code sống ở repo riêng nhưng vẫn read cùng `bridge.db`.

**Bổ sung 2 task mới:**

- [ ] **P1-T14 — Drizzle schema vendor từ contract** · Thay vì introspect trực tiếp `bridge.db`, copy schema từ `claude-bridge/schemas/db.v1.ts` vào dashboard repo qua script `bun run sync-schema` (manual cron). Giúp dashboard build offline không cần file DB.
  - Acceptance: `sync-schema` script chạy; schema TS file generate match contract version trong `package.json` `claudeBridge.compat`.
- [ ] **P1-T15 — Discovery integration** · Thay `bridge dashboard --start` (v1 P0-T6) bằng việc đọc `~/.claude-bridge/config.json` qua `discovery.ts`. Nếu daemon chưa start → empty state "Start daemon trước".
  - Acceptance: ngắt daemon → UI hiện banner "Daemon offline"; daemon up → reconnect tự động < 5s.

**Path-rewrite tasks (giữ nguyên acceptance, đổi cwd):** P1-T1 layout, P1-T2 auth, P1-T3 agents grid, ..., P1-T13 E2E. Mọi command `bun run` chạy từ dashboard repo, không phải claude-bridge root.

**Exit criteria Phase 1 (cập nhật):** Hieu dùng dashboard 1 tuần liên tục; daemon ↔ dashboard phối hợp qua config.json không cần symlink hay tweak path manual.

---

## Phase 2 — Actions (1–2 tuần) *(re-pointed + delta)*

**Delta chính:** mutation không spawn `bridge` CLI trực tiếp qua `child_process` (như v1) mà gọi MCP tool của daemon. Lý do: dashboard nằm ở repo khác, không có guarantee `bridge` binary ở `PATH`. MCP stdio (qua socket trong config) mới portable.

- [ ] **P2-T1 (rewrite) — `tasks.dispatch` qua MCP** · tRPC procedure mở MCP client connect tới daemon (endpoint trong config), gọi tool `bridge_dispatch({ agent, prompt })`. Timeout, retry, error mapping.
  - Acceptance: dispatch round-trip < 1s; lỗi MCP stdio surface thành toast với message rõ.
- Các task P2-T2 → P2-T11 (kill, audit, approve, rate limit, CSRF, permission relay, optimistic UI, confirmation) **giữ nguyên** logic, chỉ đổi từ `child_process.spawn` sang MCP client call.

**Bổ sung:**

- [ ] **P2-T12 — MCP client connection pool** · Reuse MCP stdio connection; reconnect on disconnect; backpressure khi daemon busy.
  - Acceptance: 100 mutation song song không tạo 100 stdio process; latency p95 < 500ms.

**Exit criteria Phase 2:** Dashboard độc lập với CLI binary path; mọi action đi qua MCP, audit log đầy đủ.

---

## Phase 3 — Loop & Schedule UI (1 tuần)

Không thay đổi vs v1 ngoài path re-point. P3-T1 → P3-T9 giữ nguyên acceptance. Mutation gọi MCP tool tương tự Phase 2. Cost forecast (P3-T9) đọc `bridge.db` qua Drizzle như v1.

**Exit criteria:** Mai (PM persona) tạo & quản lý 5 schedule không training CLI.

---

## Phase 4 — Polish & Multi-user (1–2 tuần) *(re-pointed)*

P4-T1 → P4-T13 giữ nguyên. Hai delta nhỏ:

- **P4-T8 (cloudflared tunnel):** flag `--tunnel` chuyển từ `bridge dashboard` (v1) sang `bun run start --tunnel` trong dashboard repo. Daemon không can thiệp.
- **P4-T9 (Docker compose):** template ship trong dashboard repo, mount `~/.claude-bridge/config.json` read-only, mount `bridge.db` read-write. Daemon Docker image tách riêng (nếu daemon support container hoá v2).
- **P4-T13 release docs:** tag `v0.1.0` ở dashboard repo; daemon repo tag `v0.5.0` riêng. README mỗi repo trỏ chéo.

**Exit criteria:** dashboard repo public release tag `v1.0.0`, 50+ external user thử trong tuần đầu.

---

## Phase 5 — MCP tool implementation *(NEW — daemon side, OUT OF SCOPE loop hiện tại)*

**Mục tiêu:** hiện thực ba MCP tool trong **claude-bridge** (`src/mcp/`). Time budget 3–5 ngày, có thể chạy song song với Phase 1 dashboard.

- [ ] **P5-T1 — `bridge_dashboard_versions`** · List installed (đọc `~/.claude-bridge/dashboards/`) + latest từ GitHub releases, cache 5 phút.
- [ ] **P5-T2 — `bridge_dashboard_install`** · Args `{ version, path? }`: resolve version → `git clone --depth 1 --branch vX.Y.Z` → `bun install` → register agent → update `config.json`. Idempotent + rollback on failure. Acceptance: full install < 60s.
- [ ] **P5-T3 — `bridge_dashboard_uninstall`** · Args `{ version }`: unregister agent (prompt chọn default mới nếu cần) → `rm -rf` → update config.
- [ ] **P5-T4 — Compat range enforcement** · Đọc `package.json` của tag, check `claudeBridge.compat` chứa daemon version; reject + suggest version phù hợp.
- [ ] **P5-T5 — Cross-repo integration test** · CI E2E: spawn daemon, install dashboard, dispatch `start`, curl `127.0.0.1:7878` → 200. Matrix 2 daemon × 2 dashboard recent.
- [ ] **P5-T6 — Bot CLAUDE.md update** · Bot biết "bật dashboard" → call `bridge_dashboard_install`. Test với persona Tâm.

**Exit criteria:** máy fresh, user gõ "bật dashboard" trên Telegram → 60s sau có URL hoạt động.

---

## Risk Register — Delta v2

Top 5 v1 vẫn áp dụng. Thêm 3 risk do repo split:

| # | Risk | P | I | Mitigation |
|---|------|---|---|------------|
| 6 | **Schema drift cross-repo** — daemon đổi DB/config schema mà dashboard chưa sync. | M | H | Schema vendor + compat range; CI integration gate; bump major khi breaking. |
| 7 | **MCP install vỡ trên Windows/WSL** — clone, install, path quote khác nhau. | M | M | Phase 5 test matrix macOS/Linux/WSL; dùng Bun API thay shell-out. |
| 8 | **Compat matrix bloat** — N daemon × M dashboard. | L | M | Chỉ support 2 minor recent mỗi side; document policy. |

---

## Cost & Timeline — Delta v2

- Phase 0.5 Migration: ~$5 token (mechanical move + docs).
- Phase 1–4: không đổi (~$210).
- Phase 5 MCP tool: ~$25 token (80% là integration test).
- **Tổng v2: $230–270** (v1: $200–250).

Time: +4–6 ngày full-time → **6–10 tuần full-time** hoặc **12–20 tuần part-time**. Infra vẫn $0/tháng.

---

## Mở rộng — Sau v2

- Pre-built single-file dashboard binary (Bun compile) để skip `bun install`.
- Auto-update banner trong dashboard, dùng `bridge_dashboard_versions`.
- Multi-user SaaS hosting (BSL license).
- Plugin marketplace evaluator template — track ở `v3-ideas.md`.

---

*End of IMPLEMENTATION-PLAN.md v2.*
