# Phase 4 — Polish & Multi-user — Task Index

> **Phase 4 goal (per v1 plan §Phase 4 + v2 deltas):** lift the
> dashboard from "đủ dùng cá nhân" (Phases 1–3 complete on `main`)
> to "đủ dùng team 5–10 người" + GA release. Add magic-link auth,
> RBAC, multi-user cost view, ⌘K palette, notification preferences,
> mobile responsive, deploy paths (cloudflared + Docker), theme
> polish, telemetry opt-in, i18n scaffold, then ship `v0.1.0`
> dashboard tag with cross-link to the daemon.
>
> **Phase 4 invariant — INHERITED FROM PHASES 2 + 3 (do NOT relax):**
> every NEW mutation procedure introduced in Phase 4 (auth.*, users.*,
> notifications.*, telemetry.*) MUST:
> 1. Travel through the existing CSRF guard
>    (`src/server/csrf-guard.ts`, P2-T08) and per-user rate-limit
>    bucket (`src/server/rate-limit-mutations.ts`, P2-T07). Magic-link
>    request endpoints get a **separate, stricter** bucket (5/min/IP,
>    matching v1 ARCH §10 brute-force mitigation).
> 2. Be recorded in `audit_log` (P2-T04) via `appendAudit({ ctx,
>    action, resource, payload })` BEFORE returning, with `request_id`
>    first-class on the tRPC ctx (P2 lesson §4). New audit actions:
>    `user.invite`, `user.revoke`, `user.role-change`, `auth.magic-link
>    -request`, `auth.magic-link-consume`, `auth.logout`,
>    `notification.preferences-update`, `telemetry.opt-in-toggle`.
> 3. Never echo free-text PII (email goes in `email_hash`, never the
>    full address; magic-link tokens are NEVER logged — only
>    `tokenIdPrefix: token.slice(0,8)` for cross-correlation).
>    Privacy precedent extended from P3-T03 (`hasGoal: true`) to
>    auth surfaces.
> 4. RBAC (T03) sits BETWEEN rate-limit and audit — `role:owner`
>    required for: `user.invite`, `user.revoke`, `user.role-change`,
>    `agent.delete` (Phase 2 surface), `task.kill` against
>    other-user tasks. `role:member` allowed for: `task.dispatch`,
>    `loop.start`, `schedule.add`, `task.kill` against own tasks
>    only. The 403 matrix is exhaustive (T03 acceptance) and gets a
>    dedicated unit-test grid (`rbac-matrix.test.ts`).
> 5. Be wrapped with `<DangerConfirm>` (P2-T11) for destructive UI
>    actions: `user.revoke`, `notification.preferences` reset.
>    `auth.logout` is reversible → no DangerConfirm.
> 6. Mobile-first: every new component MUST render at iPhone width
>    (390px) without horizontal scroll. Lighthouse mobile target
>    ≥ 90 across `/`, `/agents`, `/tasks`, `/loops`, `/schedules`,
>    `/cost`, `/audit`, `/users` (T07 acceptance).
>
> **Status:** Iter 1/16 — INDEX (this file) being committed.

---

## Source plans

- **v1 plan** (text inherited verbatim for the 13 task descriptions): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/IMPLEMENTATION-PLAN.md` — Phase 4 (P4-T1..P4-T13, lines 189–235).
- **v2 plan** (deltas only): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v2/IMPLEMENTATION-PLAN.md` — Phase 4 (lines 102–110). Three deltas:
  - **P4-T8 cloudflared:** `--tunnel` flag now lives in `bun run start --tunnel` (dashboard repo) instead of the daemon's `bridge dashboard --tunnel` CLI.
  - **P4-T9 Docker compose:** template ships in dashboard repo (this repo); mounts `~/.claude-bridge/config.json` read-only and `bridge.db` read-write.
  - **P4-T13 release docs:** `v0.1.0` tag in dashboard repo; daemon repo gets a separate `v0.5.0` tag; READMEs cross-link.
- **v1 architecture** (load-bearing): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/ARCHITECTURE.md` — §6 Auth (Magic-Link + Password Env), §10 Security (CSRF / brute-force / secret leakage / public-exposure misuse / audit log / permission relay).
- **v2 architecture** (delta only): `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v2/ARCHITECTURE.md` — §7.4 Tunnel + Cloudflared (re-points the v1 §8 procedure to the dashboard repo), §1.6 decoupled release lanes (motivates the separate `v0.1.0` tag).
- **Phase 1/2/3 sign-offs:** `docs/tasks/phase-1/PHASE-1-COMPLETE.md`, `docs/tasks/phase-2/PHASE-2-COMPLETE.md`, `docs/tasks/phase-3/PHASE-3-COMPLETE.md` — lessons learned + carry-overs.
- **Phase 3 INDEX** (sequencing pattern reference): `docs/tasks/phase-3/INDEX.md` — same structure as this file.

---

## Plan v1 vs loop-prompt task remapping (3 task delta)

The v1 plan (`P4-T1..P4-T13` lines 195–233) and the loop prompt's 13-task list **agree on 10 tasks** (T1–T9, T11). Three slots differ — the loop prompt is authoritative; v1 versions filed as Phase 5 follow-ups:

| Slot | v1 plan (P4-T*)            | Loop prompt (this INDEX)   | Reason                                                           |
|------|----------------------------|----------------------------|------------------------------------------------------------------|
| T10  | Onboarding wizard          | **Theme polish (dark/light + AA)** | Theme polish is a higher-leverage GA polish item; onboarding wizard deferred to v0.2.0 (filed). |
| T12  | Performance budget         | **i18n scaffolding (VI + EN)** | Loop prompt explicitly requests VI+EN (Vietnamese-first user base for daemon); perf budget covered by Lighthouse ≥ 90 in T07. |
| T13  | Public release docs (CLI: `bridge dashboard --start`) | **Release docs (v2 delta — `v0.1.0` dashboard tag, daemon `v0.5.0`, cross-link)** | v2 delta swap; `bun run start --tunnel` replaces CLI. |

Tasks **T1–T9 and T11 carry the v1 acceptance criteria verbatim**, augmented with the Phase 4 invariants above.

---

## What we inherit from Phases 1+2+3 (DO NOT rebuild)

Re-use as-is — every line below was verified by reading `main` at commit `ec3aa68`:

- **Auth scaffold** (Phase 1): `src/lib/auth.ts` — `signSession`/`verifySession` (HS256, 7d TTL, `sub:"owner"`). T01 **widens** `SessionPayload.sub` from the literal `"owner"` to `string` (any `users.id`). The signing primitives stay; only the type narrows.
- **Login route + middleware** (Phase 1): `app/login/page.tsx`, `app/api/auth/login/route.ts`, `app/api/auth/logout/route.ts`, `middleware.ts`. T01 adds magic-link endpoints alongside the existing password form (env password remains the owner fallback per v1 ARCH §6).
- **CSRF guard** (P2-T08): `src/lib/csrf.ts` + `src/server/csrf-guard.ts` — magic-link consume page reads the token from a one-shot URL fragment; CSRF middleware does NOT apply to the consume endpoint (a fresh visitor has no cookie yet) — instead the token itself carries the auth claim. **Enforce** that the consume route is GET-then-redirect (idempotent) and that the token is single-use (deletion in the same transaction that issues the session).
- **Rate-limit (mutations)** (P2-T07): `src/server/rate-limit-mutations.ts` — 30/min/user. T01 magic-link request gets a **separate** bucket: 5/min/IP (no user yet) + 5/hour/email-hash (anti-abuse on the recipient). New module: `src/server/rate-limit-magic-link.ts`.
- **Rate-limit (login)** (P2-T07 sibling): `src/server/rate-limit-login.ts` — already exists (5/min/IP); reuse as-is for magic-link consume failures.
- **Audit log + appendAudit** (P2-T04): `src/server/audit.ts` + `src/db/migrations/0001_audit_log.sql`. T01 adds `email_hash` (SHA-256(email + salt)) as a new audit pattern — DOES NOT add a new column, encodes inside `payload_json`.
- **MCP pool** (P2-T12): `src/server/mcp/pool.ts`. **T11 telemetry uses LOCAL writes only** (no MCP); **T01–T06 do NOT call the daemon's MCP** — auth is dashboard-local. This is a deliberate departure from the Phase 2/3 invariant ("every mutation calls MCP"); recorded in T01 review.
- **DangerConfirm** (P2-T11): `src/components/danger-confirm.tsx` — wrap user revoke + notification reset.
- **runOptimistic** (P2-T10): `src/lib/optimistic.ts` — apply to T10 theme toggle (instant feedback) and T11 telemetry toggle. NOT applied to auth (server-confirmed).
- **Vendored Drizzle schema** (Phase 0/2): `src/db/schema.ts` — read-only for daemon-owned tables. Phase 4 **adds** dashboard-owned tables (`users`, `magic_links`, `notification_preferences`, `telemetry_events`) via new migrations `0002..0005`.
- **Routers**: `src/server/routers/_app.ts` — currently mounts `agents/analytics/audit/loops/permissions/schedules/tasks`. T01 adds `auth`; T02 adds `users`; T06 adds `notifications`; T11 adds `telemetry`. Same file, do not fork.
- **next-themes** (P0 dependency, package.json): already installed at `^0.4.4` — T10 wires it (no new dep).
- **Recharts** (Phase 1 cost view): T04 multi-user cost reuses the same `<CostByDay>` shape with a `groupBy: "user_id"` knob.

**Out-of-scope for this loop** (filed against `claude-bridge-dashboard` follow-up):
- Onboarding wizard (was v1 P4-T10 — replaced by Theme polish; see swap table above). Filed against v0.2.0.
- Performance budget Lighthouse-CI gate (was v1 P4-T12 — replaced by i18n; T07 still sets a Lighthouse ≥ 90 floor for mobile, but no CI assertion). Filed against v0.2.0.
- Browser push notifications (T06 ships in-app + email digest only; v1 P4-T6 mentioned push as "optional". Default off + permission-flow stub; full impl deferred). Filed against v0.2.0.

---

## Phase 4 task list — 13 tasks (T01 … T13)

Acceptance criteria carry from v1 lines 195–233 with Phase 4 invariant additions made explicit. Tasks are sequenced top-down per the dependency graph below; the loop runs **one task per iteration** (iters 2–14 = T01..T13; iter 15 = phase tests; iter 16 = sign-off).

### T01 — Magic-link auth via Resend

**Scope:** New tables `users` + `magic_links` (migrations `0002_users.sql`, `0003_magic_links.sql`). Schema:
- `users`: `id` (UUID), `email` (UNIQUE NOT NULL), `email_lower` (generated col for case-insensitive lookup), `role` (`owner|member`, default `member`), `display_name` (nullable), `created_at`, `last_login_at`, `revoked_at` (nullable — soft delete).
- `magic_links`: `token_hash` (SHA-256 of the random 32-byte token; PRIMARY KEY), `email`, `created_at`, `expires_at` (default `created_at + 15min`), `consumed_at` (nullable, single-use guard), `request_ip_hash`.

New router `src/server/routers/auth.ts` exposing:
- `auth.requestMagicLink({ email })` — Mutation. Validates email, hits the 5/min/IP + 5/hour/email-hash bucket, creates a `magic_links` row (random 32-byte url-safe token, hashed-then-stored), sends email via Resend (`RESEND_API_KEY` + `RESEND_FROM_EMAIL` env). Always returns 200 (do NOT leak whether the email exists — privacy + anti-enumeration).
- `auth.consumeMagicLink({ token })` — Mutation. Looks up `token_hash`, atomically `UPDATE … SET consumed_at WHERE consumed_at IS NULL` (race-safe single-use), checks `expires_at > now`, finds-or-creates `users` row, sets session cookie via `signSession({ sub: user.id })`, audit `auth.magic-link-consume`.
- `auth.logout()` — Mutation. Clears cookie + audit `auth.logout`.
- `auth.me()` — Query. Returns `{ id, email, role, displayName }` for the current session, or 401.

UI: `/login` page extends to a 2-tab layout — "Password (owner)" (existing P1 form) + "Email magic link" (new). New page `/auth/consume?token=…` shows a "Signing you in…" state then redirects.

`signSession` widens `SessionPayload.sub` from `"owner"` literal → `string` (user id). Existing password login continues to work — issue a stable owner row at first login (`id: "owner-env"`, `email: env.OWNER_EMAIL || "owner@local"`, `role: "owner"`).

**Mutation Phase 4 invariant checklist:**
- [x] CSRF guard applied to `requestMagicLink` (form post from logged-out client supplies token via the public `/login` page that pre-issues CSRF cookie via middleware).
- [x] Rate limit: dedicated 5/min/IP bucket for `requestMagicLink`; 5/min/IP bucket for `consumeMagicLink` failures.
- [x] `appendAudit` actions `auth.magic-link-request`, `auth.magic-link-consume`, `auth.logout`. Payload echoes ONLY `{ emailHash, tokenIdPrefix? }` — never the email or token. Per privacy precedent.
- [x] No optimistic UI (auth is server-confirmed).
- [x] No DangerConfirm.

**Deps:** Phase 1 auth (existing primitives). **Risk:** Medium — Resend HTTP error handling, single-use race window.
**Acceptance:** email arrives < 30s on Resend free tier; token expires after 15 min; second consume of the same token returns 410 Gone with audit row `auth.magic-link-consume status=already_used`; emails are NOT logged in plaintext.

### T02 — User management page (`/users`)

**Scope:** Add `src/server/routers/users.ts` exposing:
- `users.list()` — Query. owner-only, returns all non-revoked users.
- `users.invite({ email, role })` — Mutation. owner-only, creates a `users` row in `pending_invite` state OR triggers `auth.requestMagicLink` for new email. (Decision: re-use magic-link flow for first-login; T02 just creates the user row + sends invite email via Resend with a magic-link CTA.)
- `users.revoke({ id })` — Mutation. owner-only, sets `revoked_at`. **Cannot revoke yourself.**
- `users.changeRole({ id, role })` — Mutation. owner-only, updates `role`. **Cannot demote yourself if you are the only owner.**

Build `/users` page (owner-only, members get 403 + "Ask the owner for access" page) listing users with columns: `email`, `role`, `last_login_at`, `created_at`, action buttons (Revoke wrapped in `<DangerConfirm name=email>`, Promote/Demote inline).

**Mutation Phase 4 invariant checklist:**
- [x] CSRF + rate limit (existing 30/min/user bucket).
- [x] RBAC (T03) — `users.*` mutations require `role:owner`. T02 ships an inline guard in the router; T03 generalises.
- [x] `appendAudit` actions `user.invite`, `user.revoke`, `user.role-change`. Payload `{ targetUserId, targetEmailHash, oldRole?, newRole? }`. **Email never echoed.**
- [x] DangerConfirm on revoke (`<DangerConfirm name={user.email} verb="revoke">`).
- [x] No optimistic UI (server-confirmed; safety > snappiness for permissions).

**Deps:** T01. **Risk:** Low.
**Acceptance:** owner can invite 10 users; member visiting `/users` gets 403; revoking self is blocked; demoting last owner is blocked; audit log shows correct row for each action.

### T03 — RBAC middleware (`role:owner` / `role:member`)

**Scope:** New helper `src/server/rbac.ts` exporting `requireRole(ctx, "owner" | "member")` and `requireOwnTask(ctx, taskOrLoopOrSchedule)` (for the "kill own tasks only" carve-out). Wire into every mutation procedure across all routers via a tRPC middleware. Build a **403 matrix unit-test grid** at `tests/server/rbac-matrix.test.ts`:

| Procedure                       | Anonymous | Member (own) | Member (other) | Owner |
|---------------------------------|-----------|--------------|----------------|-------|
| `agents.list` (query)           | 401       | 200          | 200            | 200   |
| `agents.delete` (mutation)      | 401       | 403          | 403            | 200   |
| `tasks.dispatch` (mutation)     | 401       | 200          | 200            | 200   |
| `tasks.kill` (mutation)         | 401       | 200          | 403            | 200   |
| `loops.start` (mutation)        | 401       | 200          | 200            | 200   |
| `loops.cancel` (mutation)       | 401       | 200          | 403            | 200   |
| `schedules.add` (mutation)      | 401       | 200          | 200            | 200   |
| `schedules.remove` (mutation)   | 401       | 200          | 403            | 200   |
| `users.list` (query)            | 401       | 403          | 403            | 200   |
| `users.invite` (mutation)       | 401       | 403          | 403            | 200   |
| `audit.list` (query)            | 401       | 403          | 403            | 200   |
| `auth.me` (query)               | 401       | 200          | 200            | 200   |

"Other" = task/loop/schedule whose `user_id` ≠ caller. Carve-out: Phase 1–3 rows where `user_id IS NULL` (legacy CLI-created records) are visible+actionable by everyone (members can kill them) — recorded in T03 review.

**Mutation Phase 4 invariant checklist:**
- [x] RBAC runs BEFORE rate-limit (denial doesn't burn rate-limit tokens).
- [x] `appendAudit` action `rbac_denied` (resource_type = the requested route; payload `{ requiredRole, callerRole, resourceUserId? }`).

**Deps:** T02. **Risk:** Medium — exhaustive 403 matrix; failure to cover is a security hole.
**Acceptance:** all 12 rows × 4 caller-roles = 48 cases pass; member can kill own tasks but gets 403 on others'; legacy `user_id IS NULL` carve-out documented + tested.

### T04 — Multi-user cost view

**Scope:** Extend `src/server/routers/analytics.ts` with `analytics.costByUser({ window: "day"|"month" })` returning `[{ userId, email, totalUsd, taskCount }]` joined from `tasks` ↔ `users` (`tasks.user_id` → `users.id`). NULL `user_id` rows bucket into a "(unattributed)" pseudo-row. Build `/cost` page additions:
- New tab "By user" alongside existing "By day" + "By agent" tabs (Phase 1).
- Leaderboard table: rank, email, total spend, task count, % of total. Filter `?window=day|month`.
- "Top spender" highlight card.

**Phase 4 invariant checklist:**
- [x] Query, no mutation — RBAC: members see `costByUser` filtered to themselves only (UI hides ranks > self); owners see all.
- [x] No audit row for queries (consistent with Phase 2/3 — only mutations are audited).
- [x] No CSRF/rate-limit (queries).

**Deps:** T03. **Risk:** Low.
**Acceptance:** numbers match `audit_log` ↔ `tasks` join (cross-checked in test); member sees own row only; owner sees all + correct % share; (unattributed) bucket is visible to owners only.

### T05 — Keyboard shortcut palette (⌘K)

**Scope:** New component `src/components/command-palette.tsx` using `cmdk` (NEW dep — `cmdk@^1.0.0`, ~14kb gzipped). Trigger: ⌘K / Ctrl+K globally. Commands:
- "Dispatch task to agent…" → opens existing P2 dispatch dialog
- "Jump to agent {name}" — fuzzy search agents
- "Search task by ID prefix" — fuzzy search recent 100 tasks
- "Start loop" — opens P3-T03 dialog
- "New schedule" — opens P3-T06 dialog
- "View audit log" → `/audit`
- "View cost dashboard" → `/cost`
- "Manage users (owner)" → `/users` (hidden for members via role check)
- "Toggle theme" (T10 wires this) — placeholder action in T05
- "Switch language" (T12 wires this) — placeholder
- "Sign out" → `auth.logout()`

Help dialog `?` lists shortcuts: `⌘K` palette, `g a` go agents, `g t` go tasks, `g l` go loops, `g s` go schedules, `g c` go cost, `g u` go users, `?` help.

**Phase 4 invariant checklist:**
- [x] No mutation (palette is pure navigation).
- [x] Renders only when authenticated (read `auth.me`).
- [x] Hidden owner-only commands when caller is `member`.

**Deps:** Phase 2 baseline + T01 (auth.me for role-aware filter). **Risk:** Low.
**Acceptance:** 10 shortcuts function; ⌘K opens palette < 100ms; help dialog accessible via `?`; arrow-key + enter navigation works; closing via Esc returns focus to previous element.

### T06 — Notification preferences + email digest

**Scope:** New table `notification_preferences` (migration `0004_notification_preferences.sql`):
- `user_id` PRIMARY KEY → `users.id`
- `in_app_enabled` (bool, default true)
- `email_digest_enabled` (bool, default false — opt-in)
- `email_digest_hour` (0..23, default 9 — local TZ; `email_digest_tz` text, default UTC)
- `browser_push_enabled` (bool, default false; STUB only — UI shows the permission button but the actual push delivery is filed against v0.2.0)
- `updated_at`

New router `src/server/routers/notifications.ts`:
- `notifications.preferences()` — Query. Returns the caller's row (creates with defaults if missing).
- `notifications.update({ inAppEnabled?, emailDigestEnabled?, emailDigestHour?, emailDigestTz?, browserPushEnabled? })` — Mutation. Self-only.

Email digest job: a `scripts/email-digest.ts` cron-style script that runs hourly (out of process — owner schedules via OS cron OR the daemon's `bridge_schedule_add` MCP call). Reads `notification_preferences WHERE email_digest_enabled = TRUE AND email_digest_hour = strftime('%H', 'now')`, summarises tasks completed in the last 24h, sends via Resend.

UI: new page `/settings/notifications` — toggle switches + hour picker.

**Mutation Phase 4 invariant checklist:**
- [x] CSRF + rate limit (30/min/user existing bucket).
- [x] RBAC (T03) — self only; owner cannot change other users' prefs.
- [x] `appendAudit` action `notification.preferences-update`. Payload `{ changes: ["inAppEnabled", "emailDigestEnabled", ...] }` (keys only, not values — privacy).
- [x] DangerConfirm on "Reset to defaults" only.
- [x] Optimistic UI on individual toggle (P2-T10).

**Deps:** T01 (users), T02 (router pattern). **Risk:** Medium — email digest scheduling moves through the daemon's MCP `bridge_schedule_add` (Phase 2 invariant) for the cron registration; the job script itself runs locally.
**Acceptance:** preferences persist across sessions; email digest delivered once per 24h at chosen hour ±5min (TZ-aware); browser-push stub shows native permission prompt + records the bool but does NOT yet send pushes (T06 review records the deferral).

### T07 — Mobile responsive pass

**Scope:** Layout audit + fixes across all routes. Sidebar (currently fixed-width left nav) collapses to a `<Sheet>` drawer at < 768px. Tables (`/tasks`, `/loops`, `/schedules`, `/audit`, `/users`) get a card-list mode at < 640px. Charts (`/cost`) get smaller height + 1-col layout on mobile.

New file: `src/components/mobile-nav.tsx` (drawer trigger). Update `app/layout.tsx` to render the drawer trigger conditionally.

Lighthouse mobile audit (Playwright + `lighthouse` CLI in CI script): targets ≥ 90 for Performance / Accessibility / Best Practices / SEO across all 8 main routes.

**Phase 4 invariant checklist:**
- [x] Pure UI — no mutation. No new audit/CSRF/rate-limit surfaces.
- [x] AA contrast (T10 hardens this).
- [x] All Phase 1–3 components stay functional on mobile.

**Deps:** all preceding tasks (this is a polish sweep over what they built). **Risk:** Low.
**Acceptance:** every route renders without horizontal scroll at iPhone width 390px; Lighthouse mobile score ≥ 90 on all 8 routes; sidebar collapses to drawer; tables become card-lists < 640px.

### T08 — Cloudflared tunnel via `bun run start --tunnel` *(v2 delta)*

**Scope:** New script `scripts/start-with-tunnel.ts` invoked via `bun run start:tunnel`. Steps:
1. Spawn the Next.js production server (`next start -p 7878`).
2. Spawn `cloudflared tunnel --url http://127.0.0.1:7878` (assume binary on PATH; print install hint on ENOENT).
3. Parse cloudflared stderr for the `https://*.trycloudflare.com` URL.
4. Print URL + QR code (use `qrcode-terminal` — NEW dep ~5kb).
5. Force-require `RESEND_API_KEY` set (anti-misuse: tunnels expose the box; magic-link auth must be active). Refuse to start if missing.
6. Force-require `DASHBOARD_PASSWORD` to be NON-default (≥ 16 chars, not the auto-generated random). Refuse if default.
7. On SIGINT, kill both child procs.

Add `package.json` script: `"start:tunnel": "bun run scripts/start-with-tunnel.ts"`.

Docs: `docs/deploy/tunnel.md` — install cloudflared on macOS (`brew install cloudflared`), Linux (deb/rpm), Windows (msi); first-run flow; security review checklist.

**Phase 4 invariant checklist:**
- [x] No new mutation surface (script wraps existing routes).
- [x] Refuses to start without auth (T01) — security gate.
- [x] No audit log (out-of-process before any tRPC call).

**Deps:** T01 (magic-link must be GA before exposing publicly). **Risk:** HIGH — security review required before merge. Review checklist in `T08-review.md`:
1. Is auth always-on under tunnel? (yes — refuse-to-start gate)
2. Is the default-password gate enforced? (yes — 16-char minimum check)
3. Do we leak the tunnel URL in audit logs? (no — out-of-process)
4. Is cloudflared spawn safe (no shell injection on user-provided env)? (yes — direct argv, no shell)
**Acceptance:** `bun run start:tunnel` prints a `*.trycloudflare.com` URL + QR; can sign in via mobile 4G; killing the parent stops both procs.

### T09 — Docker compose template *(v2 delta)*

**Scope:** New file `deploy/docker-compose.yml` (in dashboard repo per v2 delta). Service:
```yaml
services:
  dashboard:
    image: oven/bun:1.1
    working_dir: /app
    command: ["bun", "run", "start"]
    ports: ["127.0.0.1:7878:7878"]
    volumes:
      - ./:/app:ro                                 # source (read-only after build)
      - ${HOME}/.claude-bridge/config.json:/data/config.json:ro
      - ${HOME}/.claude-bridge/bridge.db:/data/bridge.db:rw
    environment:
      DASHBOARD_PASSWORD: ${DASHBOARD_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
      RESEND_API_KEY: ${RESEND_API_KEY:-}
      RESEND_FROM_EMAIL: ${RESEND_FROM_EMAIL:-}
      BRIDGE_DB_PATH: /data/bridge.db
      BRIDGE_CONFIG_PATH: /data/config.json
```

New file `deploy/.env.example` with the env-var list. `Dockerfile` (multi-stage Bun build) — copy `package.json` + `bun install --production` + copy source + `next build`.

Docs: `docs/deploy/docker.md` — `docker compose up`, persistence, daemon-side notes (daemon is a SEPARATE container; this compose runs dashboard standalone — recall v2 delta says "daemon Docker image tách riêng").

**Phase 4 invariant checklist:**
- [x] No new tRPC surface.
- [x] DB mounted read-write so the dashboard can write to `audit_log`, `users`, `magic_links`, `notification_preferences`, `telemetry_events`.
- [x] `config.json` mounted read-only — daemon owns it.

**Deps:** all preceding (the image bundles everything Phase 4 ships). **Risk:** Medium — Bun in Docker corner cases (sqlite native bindings).
**Acceptance:** `docker compose up` boots dashboard at `127.0.0.1:7878`; writes survive container restart; works in read-only mode (no daemon socket) — list pages render, mutations show "daemon offline" toast (existing P2 behaviour).

### T10 — Theme polish (dark/light + AA contrast)

**Scope:** Wire `next-themes` (already in deps) into `app/layout.tsx`:
- `<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>` wrapping `<html>`.
- Toggle in header: sun/moon icon button, also exposed via T05 ⌘K command "Toggle theme".
- Persist via localStorage (next-themes default).

CSS audit `app/globals.css` + Tailwind `dark:` variants across all components (Phase 1–3 used Tailwind defaults but did not systematically validate dark mode). New file `src/lib/theme.ts` already exists (Phase 1 stub — extend, do not replace).

AA contrast audit: run `axe-core` via Playwright on all 8 routes in both themes. Must pass `wcag2aa` rule set. Fix any failures.

**Phase 4 invariant checklist:**
- [x] No mutation.
- [x] Optimistic toggle (P2-T10) — theme switch must feel instantaneous.

**Deps:** T07 (mobile-responsive layout must be stable before applying dark mode). **Risk:** Medium — auditing every existing component for dark-mode regressions.
**Acceptance:** theme toggle persists; system-theme follow works; axe-core reports zero `wcag2aa` violations on all 8 routes in both light + dark.

### T11 — Telemetry opt-in (anonymous, no PII)

**Scope:** New table `telemetry_events` (migration `0005_telemetry_events.sql`):
- `id` autoincrement
- `install_id` (random UUID, generated once at first dashboard boot; stored in `users` `(role='owner')` settings or in a separate `dashboard_meta` k-v table if no users yet)
- `event_type` (`page_view` | `action_latency` | `feature_used`)
- `event_name` (`/agents`, `/tasks`, `dispatch.success`, etc.)
- `value_ms` (nullable — for action_latency)
- `created_at`

New router `src/server/routers/telemetry.ts`:
- `telemetry.optInStatus()` — Query. Returns `{ enabled, installId? }`.
- `telemetry.setOptIn({ enabled })` — Mutation. owner-only.
- `telemetry.record({ eventType, eventName, valueMs? })` — Mutation. NO-OP if opt-in disabled. NEVER records `user_id`, IP, UA, route params with IDs (sanitise: `/tasks/123` → `/tasks/[id]`).

UI: settings page `/settings/telemetry` — big TOGGLE (default OFF), explanation of what is and isn't sent, "View what we collect" → opens a sample of recent rows.

**Mutation Phase 4 invariant checklist:**
- [x] CSRF + rate limit.
- [x] RBAC: `setOptIn` owner-only; `record` callable by any authenticated user (UI ping).
- [x] `appendAudit` for `setOptIn` only (action `telemetry.opt-in-toggle`); `record` does NOT audit (would defeat the purpose).
- [x] No PII verified by `tests/server/telemetry-pii.test.ts` — fuzzes `eventName` with PII patterns and asserts the sanitiser strips them.

**Deps:** T01, T02. **Risk:** HIGH — privacy positioning of Bridge is "self-hosted, no telemetry by default". Review must verify (a) default OFF, (b) opt-in is explicit, (c) data POSTed to a USER-controlled endpoint (config setting `TELEMETRY_ENDPOINT`, defaults to `null` — no upload until set).
**Acceptance:** default OFF; toggling opt-in surfaces audit row; with opt-in OFF, `record` is a no-op (verified in tests); no `user_id`, IP, UA, or PII in recorded rows.

### T12 — i18n scaffolding (Vietnamese + English)

**Scope:** Add lightweight i18n via `next-intl` (NEW dep, ~15kb runtime). Two locales: `en` (default) + `vi`. Translation files at `src/i18n/messages/{en,vi}.json` covering:
- Navigation (sidebar labels)
- Login + magic-link page
- Empty/loading/error states
- Form labels for dispatch, loop start, schedule create, user invite
- Audit log action descriptions

Locale picker: header dropdown + ⌘K command "Switch language" (T05 wired this). Persist via cookie `bridge_locale` (httpOnly = false). New middleware logic: read cookie → set `<html lang>`.

Server-side: `getTranslations()` in server components; client-side: `useTranslations()` hook. Routes do NOT change (no `/vi/...` prefix — keep URLs single-locale to simplify SEO + bookmarks).

**Phase 4 invariant checklist:**
- [x] No mutation surface.
- [x] Translation files reviewed by a Vietnamese speaker (Hieu — owner of the daemon repo, native VI). Acceptance gate.

**Deps:** Phase 1–3 baseline (translates whatever copy already shipped). **Risk:** Low — scaffolding only; full translation coverage of Phase 1–3 strings is iterative.
**Acceptance:** 50+ strings translated in both locales; locale switch round-trips through cookie; missing keys fall back to `en`; lighthouse score not affected.

### T13 — Release docs + `v0.1.0` tag *(v2 delta)*

**Scope:** Three docs:
1. `README.md` — replace stub with: screenshots, GIF demo (capture via Playwright), feature list, install (`bun install` + `bun run start`), security model summary (link `/docs/web-dashboard/v2/ARCHITECTURE.md` §6 + §10), config matrix (env vars).
2. `CHANGELOG.md` — `## v0.1.0` entry summarising Phases 1–4 (compare against `git log --oneline | tail`).
3. `docs/RELEASE.md` — release process: `bun run test && bun run build && bun run test:e2e && git tag -a v0.1.0 -m "..." && (NOT git push --tags during loop)`. Document the daemon `v0.5.0` tag relationship + cross-link from each repo's README.

Cross-link daemon README (the daemon repo `claude-bridge` is at `/Users/hieutran/projects/claude-bridge` — outside this loop's repo. We DRAFT a snippet for `daemon README` in `docs/RELEASE.md` ("Add this section to claude-bridge README:") rather than editing it, since the loop is scoped to the dashboard repo only).

Tag step: `git tag -a v0.1.0 -m "Phase 1–4 GA: dashboard standalone release"`. Do NOT `git push --tags` per loop constraints (the user pushes manually after review).

**Phase 4 invariant checklist:**
- [x] No code/mutation.
- [x] Tag is local annotated only.

**Deps:** all preceding (this is the release artifact). **Risk:** Low.
**Acceptance:** README has screenshot + run-locally instructions; CHANGELOG covers all 4 phases; `v0.1.0` annotated tag exists locally; daemon cross-link snippet in `docs/RELEASE.md`.

---

## Dependency graph

```
                ┌──────────────────────────────────────┐
                │  Phases 1+2+3 baseline (DONE — main) │
                │  - signSession/verifySession         │
                │  - middleware.ts (auth + CSRF)       │
                │  - csrf-guard.ts (P2-T08)            │
                │  - rate-limit-{login,mutations}.ts   │
                │  - audit.ts + appendAudit (P2-T04)   │
                │  - DangerConfirm (P2-T11)            │
                │  - runOptimistic (P2-T10)            │
                │  - mcp/pool.ts (P2-T12)              │
                │  - 7 routers (agents..schedules)     │
                │  - SSE /tasks /permissions           │
                │  - next-themes (deps, unused)        │
                └────────────────┬─────────────────────┘
                                 │
                       ┌─────────▼──────────┐
                       │ T01 magic-link     │  ◀── CRITICAL FOUNDATION
                       │  + users + magic_  │      (8 of 13 tasks depend on it)
                       │  links migrations  │
                       └──────┬──────┬──────┘
                              │      │
              ┌───────────────┘      └────────────────┐
              │                                       │
   ┌──────────▼──────────┐                ┌───────────▼───────────┐
   │ T02 user mgmt page  │                │ T08 cloudflared tunnel│
   │  /users, users.*    │                │  (refuses without T01)│
   └──────────┬──────────┘                └───────────────────────┘
              │
   ┌──────────▼──────────┐
   │ T03 RBAC middleware │  ◀── owner/member matrix; ALL mutations now gated
   │  + 403 grid         │
   └──────────┬──────────┘
              │
   ┌──────────▼──────────┐    ┌───────────────────┐
   │ T04 multi-user cost │    │ T05 ⌘K palette    │  (parallel-safe with T04)
   │  /cost "By user"    │    │  cmdk + shortcuts │
   └─────────────────────┘    └─────────┬─────────┘
                                        │
                              ┌─────────▼─────────┐
                              │ T06 notification  │
                              │  prefs + email    │
                              │  digest stub      │
                              └─────────┬─────────┘
                                        │
                              ┌─────────▼─────────┐
                              │ T07 mobile        │  ◀── polish over T01..T06
                              │  responsive pass  │
                              └─────────┬─────────┘
                                        │
                          ┌─────────────┼─────────────┐
                          │             │             │
                ┌─────────▼─────┐ ┌─────▼────┐ ┌──────▼───────┐
                │ T09 Docker    │ │ T10 theme│ │ T11 telemetry│
                │  compose      │ │  + AA    │ │  opt-in      │
                └───────────────┘ └──────────┘ └──────────────┘
                                        │
                              ┌─────────▼─────────┐
                              │ T12 i18n VI + EN  │
                              └─────────┬─────────┘
                                        │
                              ┌─────────▼─────────┐
                              │ T13 release docs  │  ◀── final, requires
                              │  + v0.1.0 tag     │      everything green
                              └───────────────────┘
```

### Critical path

```
T01 → T02 → T03 → T04 → T05 → T06 → T07 → T09 → T10 → T11 → T12 → T13
                              ↘   ↘
                              T08 (parallel-safe with T05–T07; depends only on T01)
```

T08 (cloudflared) is the only task with a non-T01-or-prior dependency that can move out of order. It only needs T01 (auth on). To minimise context-switch in the loop, **run T08 in iter 9 (its slot in the user-supplied loop plan), AFTER T07 mobile-responsive lands** — that lets the tunnel docs include "and it works on iPhone 4G" with confidence (acceptance criterion of T08).

### Iteration mapping (loop steps 1..16)

| Step | Task                       | Why this slot                                                        |
|------|----------------------------|----------------------------------------------------------------------|
| 1    | INDEX (this commit)        | Foundation — invariant, dep graph, sequencing, env vars              |
| 2    | T01 magic-link             | Foundation; 8 of 13 tasks depend on it                              |
| 3    | T02 user mgmt              | Owner-only UI; first surface using a `users` row                    |
| 4    | T03 RBAC matrix            | Generalises T02's inline guard; required by T04 carve-out            |
| 5    | T04 multi-user cost        | First post-RBAC query surface; demonstrates role-aware filtering     |
| 6    | T05 ⌘K palette             | UX polish; depends on `auth.me` for role-aware command list         |
| 7    | T06 notification prefs     | Per-user config + email digest stub                                  |
| 8    | T07 mobile responsive      | Polish sweep over T01..T06's new surfaces + Phase 1–3 baseline       |
| 9    | T08 cloudflared tunnel     | v2 delta; security-reviewed surface; needs T01 auth + T07 mobile     |
| 10   | T09 Docker compose         | v2 delta; ships everything T01..T08 builds                           |
| 11   | T10 theme polish + AA      | Cross-cuts every component; runs after structural work is done       |
| 12   | T11 telemetry opt-in       | Privacy review surface; default OFF                                  |
| 13   | T12 i18n VI + EN           | Translation pass over Phase 1–4 strings                              |
| 14   | T13 release docs + tag     | v2 delta; final; requires every previous task green                 |
| 15   | Phase tests                | `bun test` + `bun run build` + Lighthouse + E2E sweep                |
| 16   | PHASE-4-COMPLETE.md        | Sign-off + release plan + cross-link daemon                         |

---

## Sequencing decision — auth-first foundation, then polish horizontally

Phase 2 used **foundation-first hybrid** (transport + guards before mutations). Phase 3 used **vertical-then-vertical** (loops then schedules) because the foundation already existed. Phase 4 reverts to **foundation-first** (T01 ← T02 ← T03 ← T04) for the auth/user/RBAC chain, then horizontal polish (T05–T13) where each polish task is mostly independent of the others.

**Rationale:**

1. **T01–T03 form an irreducible chain.** Magic-link tables → user CRUD → RBAC middleware. Each depends concretely on the prior. Running them out of order produces broken intermediate states (e.g., T03 RBAC matrix can't be tested without T02 user-management to seed members).
2. **T04..T13 are loosely coupled.** Most have a single upstream dep (T01 or T03). The loop runs serially anyway, so we order by:
   - User-supplied iter mapping (loop prompt is canonical for slot order).
   - Risk concentration (HIGH-risk T08 + T11 separated; T13 last for release artifact integrity).
3. **T07 mobile pass placed AFTER T06.** Doing it before T06 means we audit the same components twice (once per task surface). After T06, every Phase 4 surface is mobile-audited together.
4. **T13 last (non-negotiable).** Tag captures the SHA after every other task lands.

**Caveats that would flip the decision:**
- If T01 reveals Resend free tier doesn't deliver in < 30s reliably (acceptance criterion), we fall back to Mailtrap (dev) + manual SMTP (prod) and re-record the env-var contract. T01 review captures the decision.
- If T03 RBAC matrix reveals a Phase 2/3 mutation that was NOT user-scoped (e.g., `tasks.kill` without a user_id check on legacy CLI tasks), we backport the carve-out to those specific procedures rather than rewriting Phase 2/3. Recorded in T03 review.

**Open architectural concerns we resolve in-line (not deferred):**
- **Does Resend need DNS records (SPF/DKIM)?** For free-tier `*@resend.dev` sender, no. For custom `from` (env `RESEND_FROM_EMAIL`), yes — owner is responsible. T01 docs surface this.
- **JWT subject change is backwards-compatible.** Existing P1 password sessions have `sub: "owner"`. T01 widens the type to `string`. The owner-env user gets a stable id `owner-env` so existing sessions continue to map cleanly. Verified with a migration smoke test in T01.
- **Does telemetry endpoint exist?** No — T11 ships with `TELEMETRY_ENDPOINT` env unset by default. The `record` mutation writes to the local table only; upload-loop is filed against v0.2.0. Recorded in T11 review.
- **i18n strategy: cookie vs URL prefix.** v1 plan didn't specify. T12 chooses **cookie** (no URL change → simpler SEO + bookmarks). Decision noted in T12 review.

---

## Test surface plan

Per Phase 2/3 INDEX precedent — every task ships unit + integration + component + E2E coverage where applicable.

| Task | Server tests                          | Lib tests                  | Component tests                    | E2E (Playwright)                |
|------|---------------------------------------|----------------------------|------------------------------------|---------------------------------|
| T01  | `auth-router.test.ts` (new)           | `magic-link-token.test.ts` | `login-page.test.ts` (extend)      | `magic-link-flow.spec.ts`       |
| T02  | `users-router.test.ts` (new)          | —                          | `users-page.test.ts`               | `user-invite-revoke.spec.ts`    |
| T03  | `rbac-matrix.test.ts` (new — 48 cases)| `rbac.test.ts`             | —                                  | `rbac-403.spec.ts`              |
| T04  | `analytics-router.test.ts` (extend)   | —                          | `cost-by-user.test.ts`             | —                               |
| T05  | —                                     | `command-palette.test.ts`  | `command-palette.test.ts`          | `cmd-k.spec.ts`                 |
| T06  | `notifications-router.test.ts` (new)  | `email-digest.test.ts`     | `notification-prefs.test.ts`       | —                               |
| T07  | —                                     | —                          | `mobile-nav.test.ts`               | `mobile-viewport.spec.ts`       |
| T08  | —                                     | `tunnel-script.test.ts`    | —                                  | (manual; security review)       |
| T09  | —                                     | —                          | —                                  | (manual; `docker compose up`)   |
| T10  | —                                     | `theme.test.ts` (extend)   | `theme-toggle.test.ts`             | `dark-mode-axe.spec.ts`         |
| T11  | `telemetry-router.test.ts` (new)      | `telemetry-pii.test.ts`    | `telemetry-toggle.test.ts`         | —                               |
| T12  | —                                     | `i18n-format.test.ts`      | `locale-switch.test.ts`            | `i18n-vi.spec.ts`               |
| T13  | —                                     | —                          | —                                  | (manual; tag inspection)        |

**Phase 4 E2E target:** 8 new specs (`magic-link-flow`, `user-invite-revoke`, `rbac-403`, `cmd-k`, `mobile-viewport`, `dark-mode-axe`, `i18n-vi`, plus a smoke spec for tunnel local-only). Bringing Playwright total from 8 (Phase 3) → 16. Lighthouse mobile assertions baked into `mobile-viewport.spec.ts`.

---

## Lighthouse + E2E targets

| Route               | Lighthouse Performance | A11y | Best Practices | SEO  | E2E coverage           |
|---------------------|------------------------|------|----------------|------|------------------------|
| `/login`            | ≥ 90                   | ≥ 95 | ≥ 95           | ≥ 90 | magic-link-flow        |
| `/`                 | ≥ 90                   | ≥ 95 | ≥ 95           | ≥ 90 | (auth gate)            |
| `/agents`           | ≥ 90                   | ≥ 95 | ≥ 95           | ≥ 90 | rbac-403 (owner)       |
| `/tasks`            | ≥ 90                   | ≥ 95 | ≥ 95           | ≥ 90 | mobile-viewport        |
| `/loops`            | ≥ 90                   | ≥ 95 | ≥ 95           | ≥ 90 | (carry from P3)        |
| `/schedules`        | ≥ 90                   | ≥ 95 | ≥ 95           | ≥ 90 | (carry from P3)        |
| `/cost`             | ≥ 90                   | ≥ 95 | ≥ 95           | ≥ 90 | rbac-403 (member)      |
| `/audit`            | ≥ 90                   | ≥ 95 | ≥ 95           | ≥ 90 | rbac-403 (member 403)  |
| `/users`            | ≥ 90                   | ≥ 95 | ≥ 95           | ≥ 90 | user-invite-revoke     |
| `/settings/notifications` | ≥ 90             | ≥ 95 | ≥ 95           | ≥ 90 | (component test only)  |
| `/settings/telemetry`     | ≥ 90             | ≥ 95 | ≥ 95           | ≥ 90 | (component test only)  |

axe-core a11y assertions piggyback on every `mobile-viewport` E2E run (T07) and are duplicated under dark mode in `dark-mode-axe.spec.ts` (T10).

---

## Environment variable assumptions (graceful-fail contract)

Every new env var has a **graceful-fail** behaviour: missing → feature disabled with a one-time stderr warning + opt-out UI hint. **Refuse-to-start** only where noted (T08).

| Env var                  | Default       | Phase 4 surface using it | Failure mode if missing                                    |
|--------------------------|---------------|--------------------------|------------------------------------------------------------|
| `JWT_SECRET`             | (existing P1) | T01 session signing      | Existing P1 behaviour: middleware redirects to `/login`.   |
| `DASHBOARD_PASSWORD`     | (existing P1) | T01 owner fallback       | Same as P1.                                                |
| `RESEND_API_KEY`         | unset         | T01 magic-link, T06 digest | Magic-link UI shows "Email login disabled — set RESEND_API_KEY". Owner-env password login still works. T06 email digest is no-op. |
| `RESEND_FROM_EMAIL`      | unset         | T01, T06                 | Magic-link UI shows "Email sender not configured". Same fallback as above. |
| `OWNER_EMAIL`            | `owner@local` | T01 owner-env user row   | Default used; warning logged once.                         |
| `AUDIT_IP_HASH_SALT`     | (existing P2) | All audit                | Existing P2 behaviour: falls back to `JWT_SECRET`.         |
| `BRIDGE_DASHBOARD_ORIGIN`| `http://127.0.0.1:7878` | CSRF Origin check | Existing P2 behaviour.                              |
| `TELEMETRY_ENDPOINT`     | null          | T11 upload-loop (deferred) | No-op locally; rows accumulate in `telemetry_events` until uploaded manually. |
| `BRIDGE_LOCALE_DEFAULT`  | `en`          | T12                      | Defaults to `en`.                                          |
| `BRIDGE_DB_PATH`         | (existing)    | All phases               | Existing; daemon-owned.                                    |
| `BRIDGE_CONFIG_PATH`     | (existing)    | T09 Docker mount         | Existing; daemon-owned.                                    |

**Refuse-to-start gates (T08 only):**
- `RESEND_API_KEY` MUST be set when `start:tunnel` is invoked.
- `DASHBOARD_PASSWORD` MUST be ≥ 16 chars + non-default when `start:tunnel` is invoked.

---

## Architecture references per task (read before coding)

| Task | Sections to read |
|------|------------------|
| T01  | v1 ARCH §6 (Auth — Magic Link + Password Env), §10 (Security: brute-force, secret leakage); Resend HTTP API docs (request shape) |
| T02  | v1 ARCH §10 (audit log shape); P2-T04 audit module; P3-T07 schedule actions for the action-button row pattern |
| T03  | v1 ARCH §10 ("Permission relay abuse" → user_id ownership pattern); existing `tasks.user_id`, `loops.user_id`, `schedules.user_id` columns in schema.ts |
| T04  | v1 ARCH §3 (`tasks.user_id`, `tasks.cost_usd`); Phase 1 cost charts (recharts reuse) |
| T05  | cmdk README + ARIA combobox patterns; existing P2 `<DispatchDialog>` for the trigger flow |
| T06  | v1 P4-T6 acceptance ("setting persist; email digest 9:00"); Resend HTML email patterns |
| T07  | v1 ARCH §11 (perf budgets); Tailwind responsive breakpoints; Lighthouse mobile config |
| T08  | v1 ARCH §8 "Cloudflared tunnel" + v2 ARCH §7.4; v1 §10 "Public exposure misuse" mitigation list |
| T09  | v1 ARCH §8 "Docker Compose"; v2 IMPLEMENTATION-PLAN P4-T9 delta lines 107 |
| T10  | next-themes README; axe-core wcag2aa rule set; AA contrast (4.5:1 normal, 3:1 large) |
| T11  | v1 P4-T11 acceptance ("default OFF; UI có toggle rõ ràng; data POST đến endpoint do user kiểm soát") |
| T12  | next-intl docs (cookie strategy); existing copy in `src/components` for translation extraction |
| T13  | v2 IMPLEMENTATION-PLAN P4-T13 delta lines 108; semver convention for `v0.1.0` initial GA |

---

## Notes / open questions

- **Untracked files** (`MIGRATION-COMPLETE.md`, `docs/PHASE-2-REVIEW.md`, `tests/e2e/.fixture/`) — same as Phase 2 / Phase 3 carry-overs. Not touched by this loop.
- **No `git push`** during the loop (loop constraint).
- **`bun run sync-schema`** — Phase 2/3 follow-up. Phase 4 ADDS dashboard-owned tables (`users`, `magic_links`, `notification_preferences`, `telemetry_events`) — sync-schema is *still* not blocked because we don't touch daemon-owned tables. Re-flagged for v0.2.0.
- **Privacy invariant tightened.** P3 introduced `hasGoal: true` / `hasPrompt: true` / `hasReason: true` flags instead of echoing free text. P4 extends to: `emailHash` instead of email, `tokenIdPrefix` instead of token, `changes: ["key1", "key2"]` instead of values for prefs. Audit module keys/code is reused; only the call sites change.
- **Optimistic UI scope decision (carrying P3 §d.1 forward)**: apply to T10 theme toggle + T11 telemetry toggle + T06 individual prefs toggles. NOT applied to: T01 magic-link, T02 user mgmt, T03 RBAC denial, T13 (no UI).
- **`request_id` invariant** — P2 lesson §4 mandates first-class. Re-affirmed: every Phase 4 mutation passes `req_id` through tRPC ctx to `appendAudit`. Do not make optional.
- **Cron daemon-side gap** — recorded in P3 INDEX. T06 email digest scheduling AVOIDS re-hitting that gap by NOT calling `bridge_schedule_add` from inside the dashboard process — it ships a standalone script that owners run via OS cron OR manually trigger. Decision recorded in T06 review.
- **Daemon-side coordination for T13** — daemon repo `claude-bridge` (at `/Users/hieutran/projects/claude-bridge`) needs its own `v0.5.0` annotated tag for the cross-link to be live. The loop only operates in this repo; the daemon tag is owner-issued post-loop. T13 review captures the cross-link snippet text.

---

*Index written by loop iter 1/16 on 2026-05-07. Update checkboxes as tasks land. If a task spec changes mid-loop, edit its `T<NN>-<slug>.md` and note the delta here.*
