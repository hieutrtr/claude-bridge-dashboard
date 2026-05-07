# Phase 4 — Browser Test Plan (Manual)

> **Why manual:** the Vitest + Testing Library suites cover units +
> integration; Playwright E2E (`tests/e2e/*.spec.ts`) drives the
> contract for login → agents/tasks, ⌘K palette, CSRF, rate-limit,
> dark-mode a11y, dispatch dialog, loop / schedule flows, and the
> audit view. Lighthouse-mobile (`bun run lighthouse:mobile`) gates
> mobile UX at ≥ 90 across performance / a11y / best-practices for
> every primary route. None of those automations replicate the
> *experience* of inviting a teammate, watching a magic-link email
> land, switching language inline while the cron picker is open, or
> revoking a session and seeing the side-effect ripple to `/audit`.
> This plan is the human gate before Phase 4 ships as `v0.1.0`.
>
> **Pre-req (carried from Phase 3):** `bridge.db` reachable via
> `discoverBridgeDaemon()`; `~/.claude-bridge/config.json` populated;
> daemon running with ≥ 1 agent + ≥ 1 schedule with cost history.
> Phase 4 additionally requires:
>
> - `RESEND_API_KEY` set (T1 magic-link delivery — falls back to
>   logging the link to stderr in dev when unset; tests rely on the
>   stderr fallback).
> - `JWT_SECRET` set (Phase 1 carry-over — required by every signed
>   surface, not just T1).
> - `BRIDGE_DB` writable by the dashboard process (for the new
>   `users` and `notification_prefs` tables).
> - At least 2 distinct user accounts in the `users` table (one
>   `owner`, one `member`) to exercise RBAC denial in Step 3.
> - Optional: `cloudflared` on `$PATH` for Step 8.
> - Optional: Docker engine running for Step 9.

---

## Setup (run once)

```sh
cd /Users/hieutran/projects/bridge-bot-ts-1/claude-bridge-dashboard
bun install                                 # if cold
DASHBOARD_PASSWORD=test bun dev             # boots on :3000
# Second shell — keep dev-server logs visible to spot
# rate-limit / CSRF / magic-link warnings.
# Third shell — run `bridge` CLI for the daemon side of T11
# telemetry + T13 release verification.
```

Open <http://localhost:3000> — middleware should redirect to
`/login`. The login page now shows **two** entry surfaces (T1):

- The Phase 1 password form (carry-over for the bootstrap owner).
- A "Send magic link" form keyed off email.

From here every step assumes you stay logged in unless explicitly
told to log out.

---

## Steps

### Step 1 — Magic-link auth via Resend (T1)

- Action: log out, return to `/login`. In the magic-link form, enter
  an email already in the `users` table. Submit.
- Expected: button flips to "Check your inbox". Within ~5 s an email
  arrives from Resend with subject "Sign in to Claude Bridge". The
  link looks like `<base>/api/auth/magic-link/consume?token=…&next=/`.
  Open it: middleware swaps token → `bridge_dashboard_session`
  cookie, redirects to `/`. Audit row `auth.magic_link.request` then
  `auth.magic_link.consume` appears (no email echo — only `hasEmail`).
- Negative path 1 (unknown email): submit a random address. Server
  responds 200 with the same neutral copy ("If that email is on the
  team, a link is on its way") — **no email is sent** (anti-
  enumeration). DevTools Network — exactly one
  `POST /api/auth/magic-link/request`.
- Negative path 2 (rate limit): submit 6× in 60 s with the same
  email. The 6th attempt returns 429 + `Retry-After`. Audit row
  `rate_limit_blocked` with `payload.bucket = "magic-link"`.
- Negative path 3 (expired token): wait 16 min after the email
  arrives, then click the link. Server redirects to
  `/login?err=link_expired` and surfaces a one-line banner.
- DevTools cookie check: `bridge_dashboard_session` is `HttpOnly`,
  `SameSite=Lax`, `Secure` (in HTTPS), `Path=/`, with a 7-day exp
  matching `JWT_SECRET` claims.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 2 — User management page (T2)

- Action: nav → `/settings/users`. Owner role only — members get a
  403 (verified in Step 3). Confirm columns: `email`, `role`,
  `last_login`, `created_at`, action menu.
- Expected: invite a new email — dialog opens, email input + role
  dropdown (`owner` / `member`). Submit → row appears with status
  `pending`, magic-link copy in the toast. Resend link from the
  row's "…" menu — toast confirms re-send + audit row
  `auth.invite_resend`.
- Role change: toggle a member to owner via the row dropdown. After
  the round-trip the badge updates and the action menu re-renders
  (the demoted owner can no longer access this page until refresh).
- Revoke: click "Revoke" on a member. DangerConfirm modal opens —
  the destructive button only enables when you type the email. Wrong
  text → button stays disabled. Confirm → row disappears, the
  revoked user's session cookie is invalidated within 1 s (verified
  by them seeing `/login?err=session_revoked` on next nav).
- DevTools Network: exactly one mutation per click, each with
  `x-csrf-token`. `/audit` rows `user.invite`, `user.role_change`,
  `user.revoke` carry `{ email, role, ipHash }` — never password,
  never magic-link token.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 3 — RBAC denial matrix (T3)

- Action: log in as a `member`. Try every mutation surface a member
  is forbidden from: `/settings/users`, dispatch dialog → "Send",
  loop start, schedule create, schedule pause/resume/delete, audit
  filter `resource_type=user`.
- Expected:
  - `/settings/users` GET → 403 page with "Owner-only" copy + a
    "Back to dashboard" link. Network — no leakage of the user list
    payload.
  - Dispatch dialog: "Send" button stays disabled with a tooltip
    "Owner-only — ask your admin." (`auth.me.role !== 'owner'`).
  - Loop start / schedule create dialogs: same disabled-with-tooltip
    pattern.
  - `POST /api/trpc/users.invite` (curl past UI): server returns
    403 + body `{"code":"FORBIDDEN","message":"role_required:owner"}`.
- Cross-check: log back in as `owner`. All controls re-enable; the
  RBAC banner disappears. Audit row `auth.forbidden` for each member-
  side denial above (lets you tally the denial matrix in `/audit`
  filter `action=auth.forbidden`).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 4 — Multi-user cost split + leaderboard (T4)

- Action: nav → `/cost`. Confirm the new "By user" tab (T4). Switch
  between `By agent` (Phase 3 carry-over) and `By user`. Hover the
  leaderboard rows.
- Expected: `By user` view shows a stacked bar per user (top 10) for
  the selected window (default 7 d), plus a leaderboard table:
  `email`, `7d cost`, `30d cost`, `tasks`, `loops`. Hover → tooltip
  shows the user's split per agent. Click a row → drilldown filter
  `/cost?userId=<hash>` (URL-as-truth).
- Privacy check: emails appear only for `owner` viewers. Members see
  the same view but with hashed labels (`user-3a9b…`) — flagged in
  the page subhead. Verify by logging in as a member.
- DevTools Network: one `GET /api/trpc/analytics.costByUser` per
  filter change, response gzip ≤ 5 kB on the seeded fixture.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 5 — ⌘K command palette (T5)

- Action: from any authed route press ⌘K (or Ctrl+K on Linux/
  Windows). Type "dispatch", press Enter.
- Expected: palette mounts < 100 ms. Search filters the action list
  to "Dispatch task to agent…" (and any matching nav target). Enter
  fires `bridge:open-dispatch` event — the existing dispatch dialog
  opens. Esc closes the palette without firing any side effect.
- Leader-key check: outside any input, press `g` then `s` within
  1.5 s — navigates to `/schedules`. `g` `c` → `/cost`, `g` `a` →
  `/agents`, `g` `l` → `/loops`. `?` opens the help view inside the
  palette. None of these fire when focus is inside an input or
  contenteditable.
- Role-aware actions: as a member, the palette omits "Invite user"
  and "Start loop" / "Create schedule" — verified visually + via
  the unit test (`tests/lib/command-palette.test.ts`).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 6 — Notification preferences + email digest (T6)

- Action: nav → `/settings/notifications`. Toggle each channel
  (`in_app`, `email`, `push`) for each event family
  (`task_complete`, `loop_pending_approval`, `schedule_failed`,
  `cost_threshold`). Default state for new users is **off** for
  every row.
- Expected: each toggle round-trips a single
  `POST /api/trpc/notifications.setPref` with `x-csrf-token`. The
  switch animates < 100 ms (optimistic per Phase 2 T10) and rolls
  back if the daemon refuses (DevTools Offline mode reproduces).
  `/audit` row `notifications.set_pref` carries `{ channel, family,
  enabled }`.
- Email digest: enable `email` for `task_complete`. Run
  `bun run scripts/email-digest.ts --once` from a second shell.
  Expected: a digest email arrives within ~10 s containing the past
  hour's task completions for that user only. The digest body never
  echoes prompts (privacy precedent — only `tasks.id`, agent,
  duration, cost).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 7 — Mobile responsive pass (T7)

- Action: open DevTools device toolbar, pick **iPhone 14** (390 ×
  844). Walk every primary route: `/`, `/agents`,
  `/agents/[name]`, `/tasks`, `/tasks/[id]`, `/loops`,
  `/loops/[loopId]`, `/schedules`, `/cost`, `/audit`,
  `/settings/users`, `/settings/notifications`.
- Expected:
  - Sidebar collapses; the topbar shows a hamburger trigger
    (44 × 44 hit-target). Tapping it opens a `<Sheet>` drawer with
    the same nav items — Esc / backdrop / route change closes.
  - Body remains scrollable; sticky topbar stays in view; no
    horizontal scroll on any page (use DevTools "scrollbar" overlay
    or `body { overflow-x: hidden }` check).
  - Dispatch dialog, command palette, loop start, schedule create,
    cron picker, run-history drawer all reflow to the narrow
    viewport with no clipped controls.
- Lighthouse — `bun run lighthouse:mobile` (scripted by T07). The
  emitted `docs/tasks/phase-4/lighthouse/summary.json` records
  `passedAll: true` and per-route scores ≥ 90 for performance,
  accessibility, and best-practices on every audited route.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 8 — Cloudflared tunnel via `bun run start --tunnel` (T8 — v2 delta)

- Action: stop the dev server. From the dashboard root, run
  `cloudflared tunnel --version` to confirm the binary is on
  `$PATH` (T8 fails fast with a one-line diagnostic if missing).
  Then `bun run start:tunnel` (alias for `bun run scripts/start.ts
  --tunnel`).
- Expected: the script:
  1. Starts the dashboard on the configured port.
  2. Spawns `cloudflared tunnel --url http://localhost:<port>`
     and waits for the announced public URL.
  3. Prints the `https://*.trycloudflare.com` URL to stdout once
     ready.
  4. On Ctrl-C, kills the tunnel before the dashboard so no orphan
     process lingers (`tests/lib/tunnel.test.ts` covers the cleanup
     ordering).
- Failure paths exercised by unit tests but worth a manual sanity
  check:
  - Missing `cloudflared` → exit 1 + "install cloudflared:
    https://…" copy.
  - Port already bound → tunnel never starts; the dashboard error
    surfaces as usual.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 9 — Docker compose template (T9 — v2 delta)

- Action: `cd docker && docker compose up --build`. Wait for the
  `dashboard` service to log "Ready on http://0.0.0.0:3000".
- Expected:
  - `docker compose ps` shows two services: `dashboard` (Next.js)
    and `bridge-daemon` (the existing claude-bridge container, if
    you have a tagged image — otherwise the doc lays out the manual
    image-build step under `docker/README.md`).
  - The dashboard binds the host's `~/.claude-bridge` and
    `~/.claude` directories read-only via the volume mounts in the
    compose file (verified by `docker compose exec dashboard ls
    /root/.claude-bridge` returning the same `bridge.db` you have on
    the host).
  - Health check on `/api/auth/login` returns 200 within 30 s
    (compose `healthcheck` block).
- Bring it down: `docker compose down`. Verify no orphan volumes
  (`docker volume ls | grep claude-bridge` → empty unless you
  explicitly opted into the named-volume variant).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 10 — Theme toggle + AA contrast (T10)

- Action: from the topbar, switch theme between **Dark**, **Light**,
  and **System**. Walk every primary route in each mode.
- Expected: no FOUC (the `next-themes` `attribute="class"` flip is
  scripted before hydration). No console error / hydration warning.
  The seeded route screenshots in `tests/e2e/dark-mode-axe.spec.ts`
  pass `@axe-core/playwright` with **0 critical violations** and 0
  serious violations on the dark theme baseline. The new
  `<axe>`-driven spec audits 6 primary routes.
- AA contrast check: open DevTools → Lighthouse → "Accessibility".
  Run on `/` in light mode; the audit reports `Contrast` ≥ 90 with
  no per-element AA failures (the `--muted-foreground` token was
  re-tuned in T10 to clear AA on hsl(var(--background)) on both
  themes — the "before" failure is documented in T10 review).
- Persistence: hard-reload (`⇧⌘R`) — the theme stays. Logout +
  login — theme stays (cookie-backed, not session-bound). Open an
  incognito window — theme returns to default Dark, then can be
  switched independently.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 11 — Telemetry opt-in (T11)

- Action: nav → `/settings/telemetry`. Default state for an existing
  user is **off** (no PII can leak before consent). Toggle
  **Anonymous usage stats** on.
- Expected:
  - The toggle round-trips a single
    `POST /api/trpc/telemetry.setOptIn` with `x-csrf-token`. From
    that moment, the client sends one
    `POST /api/trpc/telemetry.event` per `pageview` / `action` /
    `latency` event, batched (debounce ~2 s, flush on
    `visibilitychange`).
  - **No PII in any event payload.** Verified manually by inspecting
    Network → response payloads + by `tests/lib/telemetry-pii.test.
    ts` which asserts the schema has no `email`, no `prompt`, no
    `goal`, no `name` keys (only `route`, `action`, `latencyMs`,
    `userIdHash`, `sessionId`).
  - `/audit` row `telemetry.opt_in` and `telemetry.opt_out` capture
    the consent moment.
- Disable check: toggle off. The next `pageview` does not fire (a
  console marker logs "telemetry: disabled — drop"). The opt-out
  is sticky across sessions.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 12 — i18n switch (vi + en) (T12)

- Action: from the topbar `<LanguageSwitcher>` (a native `<select>`
  to keep the touch-target story honest), switch from **English**
  to **Tiếng Việt**. Walk every primary route + dialogs.
- Expected:
  - The page hydrates with Vietnamese strings without a full re-
    download — `next/router.refresh()` is enough because the layout
    re-reads the cookie-resolved locale per request.
  - The `<html lang="vi">` attribute updates (visible via DevTools
    Elements). Screen readers using lang-aware pronunciation pick
    up the change.
  - All 70 keys defined in `src/i18n/messages/{en,vi}.json` resolve
    — no string falls back to the key itself (verified by
    `tests/lib/i18n-locales.test.ts` which byte-locks the two
    files' key sets).
  - Switch back to English — same flow, no FOUC.
- Cookie precedence: clear the `bridge_locale` cookie. Reload —
  language falls back to the `Accept-Language` header. Set
  `Accept-Language: vi-VN` in DevTools → page renders in Vietnamese
  on first paint.
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

### Step 13 — Release docs + `v0.1.0` tag (T13 — v2 delta)

- Action: in the dashboard repo, run `git tag --list 'v*'`. Open
  `docs/RELEASE.md`, `RELEASE-NOTES-v0.1.0.md`, `CHANGELOG.md`.
- Expected:
  - `docs/RELEASE.md` enumerates the cross-link to the daemon repo
    (`bridge-bot-ts-1`) and to the public `claude-bridge` README,
    plus a step-by-step release checklist (build → tag → upload).
  - `RELEASE-NOTES-v0.1.0.md` lists every Phase 1 + 2 + 3 + 4 task
    with a one-line description, grouped by phase, with the commit
    hash next to each.
  - `CHANGELOG.md` carries a `## v0.1.0 — 2026-05-07` section that
    matches the release notes (Keep-a-Changelog format).
  - `git tag --list 'v*'` prints `v0.1.0` (annotated tag, `git
    cat-file -t v0.1.0` → `tag`). The tag's body matches the
    release notes' header. **No `git push --tags`** — the tag is
    local; the repo owner pushes it manually.
- Daemon cross-link: open the daemon repo (../claude-bridge) — its
  README has a "Web dashboard" section linking back to this repo +
  this version. The README diff is in T13's commit (`docs(release):
  daemon README cross-link`).
- [ ] Pass / [ ] Fail / [ ] Note: ___________________________

---

## Cross-cutting checks

- [ ] **DevTools Console** — zero errors, zero React-19 hydration
  warnings on every Phase 4 route + every dialog / drawer / sheet.
  Known noisy lines (EventSource reconnect from `/api/stream/tasks`
  and `/api/stream/permissions`) are bounded and documented in
  Phase 2.
- [ ] **DevTools Network** — every Phase 4 mutation request carries
  `x-csrf-token`; no `x-csrf-token` ever appears on a `GET`. Every
  successful mutation has a corresponding audit row within 1 s.
- [ ] **Logout + replay** — log out, then re-paste any Phase 4 URL
  (`/settings/users?role=member`, `/cost?userId=…`,
  `/settings/notifications`). Expect redirect → `/login?next=…`.
  Log back in as the right role — the deep link round-trips.
- [ ] **Privacy invariant** — across all 13 steps, no audit row,
  telemetry event, or email digest leaks raw `email`, `prompt`,
  `goal`, `reason`, or magic-link token. Only `hasField`-style
  flags or hashed identifiers.
- [ ] **Mobile parity** — every step that introduces a new dialog
  / drawer / page passes Step 7's mobile checklist
  (Lighthouse ≥ 90, no horizontal scroll, all controls reachable
  with a thumb).

---

## Automated suite summary (`bun test` + `bun run test:e2e` + `bun run lighthouse:mobile`)

| Suite | Result | Notes |
|------|--------|-------|
| `bun test tests/lib tests/app tests/server` | **1462 / 0 fail** (6982 expects) | log: `docs/tasks/phase-4/test-results/bun-test.log` |
| `bun run build` | clean (Next.js 15.5.15) | log: `docs/tasks/phase-4/test-results/bun-build.log` |
| `bun run lighthouse:mobile` | **8 / 8 routes ≥ 90** | summary: `docs/tasks/phase-4/test-results/lighthouse-summary.json` |
| `bun run test:e2e` | **11 / 11 specs pass** (`audit-view`, `command-palette`, `csrf`, `dark-mode-axe ×2`, `dispatch-dialog`, `loop-flow ×2`, `rate-limit`, `schedules-flow`, `smoke`) | log: `docs/tasks/phase-4/test-results/e2e.log` |

Phase-4 specifics on top of Phase 3 carry-over:

- `dark-mode-axe.spec.ts` (T10) — `@axe-core/playwright` audit on 6
  primary routes in dark theme; theme persistence across hard
  reload.
- `command-palette.spec.ts` (T05) — ⌘K opens, search → Enter
  activates "Dispatch task to agent", Esc closes. The interactive
  path uses `Command.Input.fill` + Enter rather than a direct option
  click because cmdk's Radix-Dialog overlay briefly intercepts
  pointer events during the entrance animation; the typed-and-Enter
  path is the same the keyboard user takes.
- `tests/server/rbac-matrix.test.ts` — every mutation route asserts
  the 403 matrix for `member` callers (T3 acceptance).
- `tests/server/auth-router.test.ts` + `magic-link-token.test.ts` —
  end-to-end magic-link request → consume → session cookie path,
  including the 15-min token TTL and the anti-enumeration neutral
  response.
- `tests/lib/i18n-locales.test.ts` — byte-locks the 70-key
  `en.json` and `vi.json` so future PRs cannot diverge silently.
- `tests/lib/telemetry-pii.test.ts` — schema-asserts the telemetry
  payload contract (no PII).
- `tests/lib/tunnel.test.ts` (T8) and `tests/lib/docker-config.test.ts`
  (T9) — config / process-orchestration coverage for the v2 deltas.

---

## Sign-off

- Tester: _______________________________________
- Date: _________________________________________
- Browser / version: ____________________________
- Daemon version: _______________________________
- Dashboard version: `v0.1.0` (`git tag` from T13)
- Overall: [ ] PASS / [ ] FAIL / [ ] PASS-WITH-NOTES

> If any step fails, file it under "v0.1.0 release blockers" before
> tagging the daemon repo + announcing the GA. Phase 4 is the user-
> visible team surface for Claude Bridge — magic-link delivery,
> RBAC denial, and mobile a11y are the parts a teammate will hit on
> day one.
