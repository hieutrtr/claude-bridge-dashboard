# Phase 4 — Polish & Multi-user — Sign-off

- **Date completed:** 2026-05-07
- **Branch:** `main`. Phase 4 commit range
  `92792d3..6b10748` (14 task / test / docs commits + this sign-off
  commit). No force-push, no remote push, no `git push --tags`.
- **Local annotated tag:** `v0.1.0` on `ba4c3ce` (T13 release-docs
  commit). The owner pushes both `main` and the tag manually after
  reading this sign-off — see "Release plan" below.
- **Phase invariant held** (inherited from Phase 2 + 3, extended for
  Phase 4 in `INDEX.md`):
  every new mutation procedure (`auth.*`, `users.*`,
  `notifications.*`, `telemetry.*`) travels through CSRF guard
  (`src/server/csrf-guard.ts`) → per-user mutation rate-limit
  (`src/server/rate-limit-mutations.ts`) → **RBAC middleware**
  (T03, owner / member matrix) → audit-log write
  (`src/server/audit.ts`) → MCP transport (where applicable),
  with `<DangerConfirm>` on destructive surfaces
  (`user.revoke`, `notification.preferences-reset`). Free-text
  PII (`email`, magic-link `token`) is NEVER echoed in audit
  payloads — only `email_hash` and `tokenIdPrefix: token.slice(0,8)`
  for cross-correlation. Privacy precedent extended from
  `hasGoal: true` (P3) to `hasEmail: true` / no-`prompt` /
  no-`reason` for auth + telemetry surfaces. Verified per-task in
  each `T<NN>-review.md` and exhaustively by
  `tests/server/rbac-matrix.test.ts`.
- **Sequencing:** vertical-then-vertical (T01→T13 in plan order),
  same shape as Phase 3. Auth + RBAC (T01–T03) intentionally
  precede every other Phase 4 mutation so retroactive 403 gating
  on Phase 1–3 routes lands once, not twice.

---

## 13-task checklist

Each task ships a spec and a review under
`docs/tasks/phase-4/T<NN>-*.md`. Reviews capture decisions,
test counts, and follow-ups.

- [x] **T01** — Magic-link auth via Resend — [`T01-magic-link-auth.md`](T01-magic-link-auth.md) · [`T01-review.md`](T01-review.md) · `92792d3`
- [x] **T02** — User management page — [`T02-user-management.md`](T02-user-management.md) · [`T02-review.md`](T02-review.md) · `89ed9e1`
- [x] **T03** — RBAC middleware (owner / member, 403 matrix) — [`T03-rbac-middleware.md`](T03-rbac-middleware.md) · [`T03-review.md`](T03-review.md) · `aa20eee`
- [x] **T04** — Multi-user cost split + leaderboard — [`T04-multi-user-cost.md`](T04-multi-user-cost.md) · [`T04-review.md`](T04-review.md) · `b21dfdf`
- [x] **T05** — ⌘K command palette — [`T05-command-palette.md`](T05-command-palette.md) · [`T05-review.md`](T05-review.md) · `cf4b707`
- [x] **T06** — Notification prefs + email digest — [`T06-notification-prefs.md`](T06-notification-prefs.md) · [`T06-review.md`](T06-review.md) · `1fa2d91`
- [x] **T07** — Mobile responsive + Lighthouse ≥ 90 — [`T07-mobile-responsive.md`](T07-mobile-responsive.md) · [`T07-review.md`](T07-review.md) · `09d927a`
- [x] **T08** — Cloudflared tunnel via `--tunnel` *(v2 delta)* — [`T08-cloudflared-tunnel.md`](T08-cloudflared-tunnel.md) · [`T08-review.md`](T08-review.md) · `d49d621`
- [x] **T09** — Docker compose template *(v2 delta)* — [`T09-docker-compose.md`](T09-docker-compose.md) · [`T09-review.md`](T09-review.md) · `6516a2b`
- [x] **T10** — Theme polish + AA contrast — [`T10-theme-polish.md`](T10-theme-polish.md) · [`T10-review.md`](T10-review.md) · `fc1f884`
- [x] **T11** — Telemetry opt-in (no PII) — [`T11-telemetry-opt-in.md`](T11-telemetry-opt-in.md) · [`T11-review.md`](T11-review.md) · `0344e43`
- [x] **T12** — i18n scaffolding (vi + en) — [`T12-i18n-scaffolding.md`](T12-i18n-scaffolding.md) · [`T12-review.md`](T12-review.md) · `827b045`
- [x] **T13** — Release docs + `v0.1.0` tag *(v2 delta)* — [`T13-release-docs.md`](T13-release-docs.md) · [`T13-review.md`](T13-review.md) · `ba4c3ce`

13 / 13 task spec + review files on file. INDEX (`INDEX.md`) and
manual browser-test plan (`PHASE-BROWSER-TEST.md`) ship alongside.

---

## Test evidence

Raw logs land under `docs/tasks/phase-4/test-results/` and
Lighthouse reports under `docs/tasks/phase-4/lighthouse/`.

### `bun test` (scoped: `tests/lib tests/app tests/server`)

```
1462 pass · 0 fail · 6982 expect() calls · 102 files · 4.63s
```

Log: [`test-results/bun-test.txt`](test-results/bun-test.txt).

Phase 4 added **516 unit / integration / component tests** on top
of Phase 3's 946. The bulk lands in `tests/server/*` (auth-router,
users-router, notifications-router, telemetry-router,
rbac-matrix), `tests/lib/*` (magic-link-token, command-palette,
i18n-locales, telemetry-pii, tunnel, docker-config), and
`tests/app/*` (responsive-shell, users-page, notification-prefs).

Two tests deliberately exercise audit-log failure paths and the
audit module logs the trapped errors to stderr (visible in the
log) — both tests still **pass**; the logging confirms the
"audit write failed → null payload" guard works as intended.

### `bun run typecheck`

Silent — 0 errors.

### `bun run build`

Clean (Next.js 15.5.15). First Load JS shared by all = **102 kB**.
No route ballooned over Phase 3 baseline.
Log: [`test-results/bun-build.txt`](test-results/bun-build.txt).

### `bun run test:e2e` (Playwright)

```
11 passed (2.0m) · chromium · 1 worker
```

Log: [`test-results/e2e.txt`](test-results/e2e.txt).
HTML report: [`test-results/playwright-report.html`](test-results/playwright-report.html).

| # | Spec | Phase | Notes |
|---|------|-------|-------|
| 1 | `audit-view.spec.ts` | P2 carry | owner sees `/audit` heading + filters |
| 2 | `command-palette.spec.ts` | **P4 T05** | ⌘K opens, "Dispatch task" → dispatch dialog |
| 3 | `csrf.spec.ts` | P2 carry | mutation w/o CSRF token → 403 |
| 4 | `dark-mode-axe.spec.ts` (audit) | **P4 T10** | axe-core wcag2aa across 6 routes |
| 5 | `dark-mode-axe.spec.ts` (persist) | **P4 T10** | theme persists across hard reload |
| 6 | `dispatch-dialog.spec.ts` | P2 carry | topbar trigger opens, lists agents |
| 7 | `loop-flow.spec.ts` (cancel) | P3 carry | start → cancel via typed-prefix confirm |
| 8 | `loop-flow.spec.ts` (approve) | P3 carry | approve clears `pending_approval` |
| 9 | `rate-limit.spec.ts` | P2 carry | burst → 429 |
| 10 | `schedules-flow.spec.ts` | P3 carry | create → pause → delete |
| 11 | `smoke.spec.ts` | P1 carry | login → agent → task → result |

### `bun run lighthouse:mobile`

`passedAll: true` across **8 / 8** primary routes. Summary:
[`lighthouse/summary.json`](lighthouse/summary.json) +
[`test-results/lighthouse-summary.json`](test-results/lighthouse-summary.json).
Per-route reports under [`lighthouse/`](lighthouse/).

| Route | Perf | A11y | BP | SEO | Pass |
|-------|-----:|-----:|---:|----:|:----:|
| `/` | **94** | 98 | 96 | 91 | ✅ |
| `/agents` | **99** | 98 | 100 | 91 | ✅ |
| `/tasks` | **98** | 100 | 100 | 91 | ✅ |
| `/loops` | **98** | 100 | 100 | 91 | ✅ |
| `/schedules` | **99** | 100 | 100 | 91 | ✅ |
| `/cost` | **98** | 99 | 100 | 91 | ✅ |
| `/audit` | **98** | 100 | 100 | 91 | ✅ |
| `/settings/users` | **98** | 100 | 100 | 91 | ✅ |

Every score ≥ 90 across Performance / Accessibility /
Best-Practices / SEO. Worst cell is the root performance score
(94) and is dominated by the marketing hero render — well clear
of the 90 gate.

---

## RBAC 403 matrix (T03 — exhaustive)

Asserted by `tests/server/rbac-matrix.test.ts`. Mutation paths
not in the table below are member-allowed (e.g. `task.dispatch`
on the caller's own agents, `loop.start`, `schedule.add`, own-task
`task.kill`). Every entry below returns **403 Forbidden** with
body `{"code":"FORBIDDEN","message":"role_required:owner"}` and
emits an `auth.forbidden` audit row capturing
`{ procedure, callerRole, requiredRole, ipHash }`.

| Surface | Procedure | Member | Owner |
|---------|-----------|:------:|:-----:|
| User mgmt | `users.invite` | 403 | ✅ |
| User mgmt | `users.revoke` | 403 | ✅ |
| User mgmt | `users.role-change` | 403 | ✅ |
| User mgmt | `users.list` (owner-only PII) | 403 | ✅ (full email) |
| User mgmt | `users.list` (hashed view) | ✅ (`user-3a9b…`) | ✅ |
| Agent mgmt | `agents.delete` | 403 | ✅ |
| Tasks | `task.kill` (other-user) | 403 | ✅ |
| Tasks | `task.kill` (own) | ✅ | ✅ |
| Audit | `audit.list` filter `resource_type=user` | 403 | ✅ |
| Cost | `analytics.costByUser` (full email view) | 403 | ✅ |
| Cost | `analytics.costByUser` (hashed view) | ✅ | ✅ |
| Auth | `auth.magic-link-request` (own email) | ✅ | ✅ |
| Auth | `auth.magic-link-request` (others' email, anti-enum) | neutral 200 | neutral 200 |
| Notifications | `notifications.set-pref` (own) | ✅ | ✅ |
| Notifications | `notifications.reset` (own) | ✅ | ✅ |
| Telemetry | `telemetry.set-opt-in` (own) | ✅ | ✅ |
| Telemetry | `telemetry.event` (own) | ✅ | ✅ |

UI surfaces tooltip the disabled state ("Owner-only — ask your
admin") rather than hide controls — the hidden-control pattern
silently desyncs when a member is promoted mid-session.

---

## Accessibility result (T07 + T10)

- **Lighthouse mobile A11y ≥ 98** on every primary route (table
  above). Per-element AA contrast clean after T10 retuned
  `--muted-foreground` for both themes.
- **`@axe-core/playwright` audit** (`tests/e2e/dark-mode-axe.spec.
  ts`): **0 critical** + **0 serious** violations across 6 primary
  routes in the **dark theme baseline**. Run logged as 22.8 s in
  the e2e summary above.
- **Theme persistence** spec (T10): hard reload preserves the user
  choice — verifies `next-themes` `attribute="class"` flip is
  scripted before hydration (no FOUC, no console error).
- **Touch targets:** mobile shell (T07) ships a 44 × 44 px
  hamburger trigger; ⌘K trigger and topbar buttons follow the
  same minimum.
- **Language switcher** (T12): native `<select>` deliberately
  preserved over a custom dropdown — keeps the keyboard-navigation
  story honest and is screen-reader-correct on every platform.

---

## Release plan — `v0.1.0`

This is what the owner does next. Nothing below has been
auto-executed.

### What landed during the loop (do NOT redo)

1. `git tag -a v0.1.0 -m "v0.1.0 — Phase 1-4 GA: standalone
   dashboard release"` on commit `ba4c3ce` (T13).
   - Verify locally: `git tag --list 'v*'` → `v0.1.0`.
   - Verify type: `git cat-file -t v0.1.0` → `tag` (annotated).
   - Verify body: `git tag -l v0.1.0 -n20` matches the
     `RELEASE-NOTES-v0.1.0.md` summary.
2. Release artifacts on `main`:
   - [`README.md`](../../../README.md) — GA-quality install / run /
     Docker / tunnel / env-vars matrix / troubleshooting /
     compat window / security model + cross-link to daemon.
   - [`CHANGELOG.md`](../../../CHANGELOG.md) — Keep-a-Changelog,
     per-phase task summary (Phases 1–4), compat matrix,
     `v0.2.0` carry-overs.
   - [`RELEASE-NOTES-v0.1.0.md`](../../../RELEASE-NOTES-v0.1.0.md) —
     tl;dr install, feature highlights by category, migration
     path, verification commands.
   - [`docs/RELEASE.md`](../../RELEASE.md) — pre-flight runbook,
     tag step, post-push owner actions, daemon README cross-link
     snippet, **versioning rationale** (why `v0.1.0` not `v1.0.0`).

### What the owner runs to publish

```bash
# 1. Sanity check the local state.
cd /Users/hieutran/projects/bridge-bot-ts-1/claude-bridge-dashboard
git status                                # clean working tree
git log --oneline origin/main..HEAD       # 15 unpushed commits + this sign-off
git tag -l v0.1.0 -n20                    # annotated tag body matches RN

# 2. Publish.
git push origin main
git push origin v0.1.0

# 3. Author the GitHub release.
#    - Title: "v0.1.0 — Phase 1-4 GA: standalone dashboard release"
#    - Body : copy/paste RELEASE-NOTES-v0.1.0.md verbatim
#    - Attach: optional screenshots from PHASE-BROWSER-TEST.md run
```

> **Do NOT** push tags from a loop, scheduled job, or background
> agent. The push is a deliberate owner action so the GitHub
> release can be authored alongside.

### Daemon repo cross-link (`bridge-bot-ts-1` /
   `claude-bridge`)

The daemon repo (`/Users/hieutran/projects/claude-bridge`) is
**not** modified by this loop — the cross-link is a follow-up
the owner applies after the dashboard tag is public.

1. Open the daemon repo's README. Add a **Dashboard** section
   using the snippet in
   [`docs/RELEASE.md`](../../RELEASE.md#daemon-repo-cross-link-snippet).
2. The snippet documents the compat matrix:
   `daemon v0.5.x` → `dashboard v0.1.0`, `daemon v1.0.x` →
   `dashboard v0.1.0`. The daemon is currently at `v1.0.4` — the
   matrix already covers it.
3. The daemon's own tag scheme is independent. **Do NOT** retag
   the daemon to match the dashboard. v1 plan said
   "daemon v0.5.0" but the daemon line had already advanced to
   `v1.0.x` before this loop started; v2 architecture treats
   that as a compat window rather than a forced retag (see
   `docs/RELEASE.md#versioning-rationale`).
4. Suggested daemon-side commit title:
   `docs(release): cross-link claude-bridge-dashboard v0.1.0`.

---

## Known follow-ups (filed for `v0.2.0`)

Carry-overs already enumerated in [`CHANGELOG.md`
"Out of scope"](../../../CHANGELOG.md) and surfaced in per-task
reviews:

- **Onboarding wizard** (originally v1 P4-T10 — slot taken by
  theme polish). Multi-step intro for first-time owners.
- **Lighthouse-CI gate** — perf-budget assertion in CI.
  `bun run lighthouse:mobile` is the manual baseline today.
- **Browser push notifications** — full delivery (today's stub
  ships only the permission prompt).
- **Telemetry upload-loop** — `TELEMETRY_ENDPOINT` consumer.
  Today's `record` mutation writes to `telemetry_events` locally;
  no upload until the owner sets the env.
- **ICU plural rules + a third locale** — current i18n scaffold
  ships 70 keys × 2 locales (en, vi) without ICU plurals.
- **Per-route copy translation** — i18n covers the chrome
  (sidebar, topbar, login, mobile-nav, language switcher); body
  copy on `/cost`, `/audit`, `/users` etc. remains English.
- **`bun run sync-schema`** — automated daemon-side schema
  mirroring (today: re-introspect manually).
- **react-i18next removal** — ~6 kB shared-chunk savings if we
  inline the message catalog.

Each follow-up has a parking-lot entry in the corresponding
`T<NN>-review.md`.

---

## Verification

Done condition for iter 16: this file exists at
`docs/tasks/phase-4/PHASE-4-COMPLETE.md`, the final commit
(`docs(phase-4): PHASE-4-COMPLETE sign-off + release plan`) is on
`main`, and the suite reproduces:

```bash
cd /Users/hieutran/projects/bridge-bot-ts-1/claude-bridge-dashboard
bun run typecheck                    # silent
bun test                             # 1462 pass · 0 fail
bun run build                        # clean
bun run test:e2e                     # 11 specs pass
bun run lighthouse:mobile            # 8 / 8 routes ≥ 90
git tag -l v0.1.0 -n5                # annotated tag, body matches RN
git log --oneline origin/main..HEAD  # 16 unpushed commits incl. this sign-off
```

Phase 4 is **complete**.
