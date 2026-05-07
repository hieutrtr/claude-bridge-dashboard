# Release Notes — v0.1.0 (2026-05-07)

> Initial general-availability release of `@claude-bridge/dashboard`. The
> dashboard is now ready for **team use up to ~10 people** behind a strong
> password + magic-link auth, with optional Cloudflare tunnel exposure or a
> self-hosted Docker compose deploy.

This is the first stable, tagged release of the dashboard repo as a standalone
artifact. Future releases version independently from the `claude-bridge` daemon
([compatibility matrix](README.md#compatibility)).

---

## tl;dr

```bash
git clone https://github.com/hieutrtr/claude-bridge-dashboard
cd claude-bridge-dashboard
git checkout v0.1.0
bun install

export JWT_SECRET=$(openssl rand -base64 48)
export DASHBOARD_PASSWORD='use-at-least-16-chars-not-the-default'
# optional but recommended for multi-user:
export RESEND_API_KEY=re_xxx
export RESEND_FROM_EMAIL='dashboard@your-domain.example'

bun run build && bun run start          # http://127.0.0.1:7878
# or
bun run start:tunnel                    # public *.trycloudflare.com URL + QR
```

Sign in at `/login` with `DASHBOARD_PASSWORD`. The first login provisions a
stable owner row (`owner-env`) so existing P1 sessions continue to work; invite
team-mates via the **Magic-link tab** once Resend is configured.

---

## What's new (since the unreleased pre-Phase-1 baseline)

The dashboard was developed across four phases on `main`. v0.1.0 captures the
state at commit `<HEAD-of-main>` after Phase 4 lands. See
[CHANGELOG.md](CHANGELOG.md) for the full task-by-task breakdown.

### 🔐 Auth & multi-user

- **Magic-link login** via Resend (15-min single-use tokens, hashed-at-rest).
- **Owner / member RBAC** with a 48-cell 403 matrix.
- **User management page** (`/users`, owner-only): invite, revoke, change role,
  with self-protection guards (cannot revoke yourself; cannot demote the only
  owner).
- **Audit log** (`/audit`) — every mutation since Phase 2 is recorded; emails
  hashed, magic-link tokens never plaintext.

### 📊 Observability

- **Agents** grid + detail with Tasks tab + read-only Auto Memory tab.
- **Tasks** global list (filters) + detail with JSONL transcript viewer.
- **Loops** list / detail with cost sparkline + per-iteration timeline; start /
  cancel / approve / reject inline.
- **Schedules** CRUD with cron picker (cronstrue), pause / resume, run-history
  drawer, **cost forecast** for the next N runs.
- **Cost analytics** (`/cost`) — by day, by agent, by user (Phase 4),
  leaderboard, "top spender" highlight.
- **SSE live updates** for tasks + permission relay toasts.

### ⚡ UX polish

- **⌘K command palette** with fuzzy search across agents, recent tasks, common
  actions; role-aware filtering; `?` help.
- **Optimistic UI** with rollback on mutation failure.
- **`<DangerConfirm>`** wrapper on every destructive action.
- **Mobile responsive** pass: drawer sidebar < 768px, card-list tables < 640px,
  Lighthouse mobile ≥ 90 on every route.
- **Dark / light theme** toggle (next-themes), AA contrast verified by axe-core
  on every route in both themes.
- **i18n scaffold** — English + Vietnamese (70 keys × 11 namespaces). Cookie
  persistence, no URL prefix.
- **Notification preferences** — in-app, email digest (hourly cron via
  `scripts/email-digest.ts`), browser-push stub.

### 🔒 Security

- **CSRF** double-submit cookie pattern on every mutation.
- **Rate limit** — 30/min/user mutations, 5/min/IP login + magic-link request,
  5/hour/email-hash anti-enumeration.
- **Telemetry opt-in** — default OFF, anonymous, install-scoped (no `user_id`),
  PII scrubber, no upload endpoint until owner sets `TELEMETRY_ENDPOINT`.

### 📦 Deploy

- `bun run start` — localhost-only production server (binds 127.0.0.1:7878).
- `bun run start:tunnel` — wraps `cloudflared` for instant public URL + QR.
  Refuses to start without strong password + Resend env. Security checklist in
  [`docs/deploy/tunnel.md`](docs/deploy/tunnel.md).
- `docker compose` — non-root container, mounts `config.json` read-only,
  `bridge.db` read-write, healthcheck. See
  [`docs/deploy/docker.md`](docs/deploy/docker.md).

---

## Compatibility

- **Bun ≥ 1.1** (Bun is the only supported runtime; Node is not used).
- **`claude-bridge` daemon ≥ v1.0.0.** The dashboard reads the daemon-owned
  `agents`, `tasks`, `loops`, `schedules` tables (schema vendored at
  `src/db/schema.ts` — re-introspect with `bun run db:introspect` after a
  daemon-breaking schema change). The dashboard writes its own tables only
  (`audit_log`, `users`, `magic_links`, `notification_preferences`,
  `telemetry_events` under `src/db/migrations/`).
- **Browsers:** latest Chrome / Firefox / Safari. iPhone Safari + Chrome on
  iOS verified at width 390px.

---

## Migration / upgrade path

This is the first tag, so there is no prior version to upgrade from. For
pre-tag installs running off `main`:

1. `git fetch && git checkout v0.1.0` to pin to the GA tag.
2. `bun install` — picks up `i18next`, `react-i18next`, `cmdk`, etc. that
   landed during Phase 4.
3. **Database migration is automatic** on first boot: the dashboard runs
   pending migrations under `src/db/migrations/` (drizzle-kit) against
   `bridge.db`. Phase 4 added `0002_users.sql`, `0003_magic_links.sql`,
   `0004_notification_preferences.sql`, `0005_telemetry_events.sql`.
4. **Existing P1 password sessions remain valid.** The owner-env user is
   provisioned at first login with id `owner-env` and `role='owner'`.
5. If you intend to invite team-mates: set `RESEND_API_KEY` +
   `RESEND_FROM_EMAIL`, then visit `/users` and invite by email.

---

## Known limitations

- **Browser push notifications** ship as a permission-prompt stub only — full
  delivery is filed for v0.2.0.
- **Telemetry upload** is local-only. The `record` mutation writes to
  `telemetry_events`; the upload-loop is filed for v0.2.0.
- **i18n coverage** is the chrome (sidebar, topbar, login, mobile-nav, language
  switcher). Per-route copy translation is iterative — filed for v0.2.0.
- **`bun run sync-schema`** to mirror daemon-side schema changes is not yet
  shipped — re-introspect manually with `bun run db:introspect`.
- **Lighthouse-CI** gate is not in CI yet — `bun run lighthouse:mobile` is the
  manual baseline (v0.2.0 will assert in CI).

See [`docs/tasks/phase-4/PHASE-4-COMPLETE.md`](docs/tasks/phase-4/PHASE-4-COMPLETE.md)
for the full carry-over list (sign-off lands in iter 16/16).

---

## Verification

```bash
$ bun test
1462 pass · 0 fail · 86 files

$ bun run typecheck
(no output — 0 errors)

$ bun run build
✓ Compiled successfully · 13 routes · First Load JS shared 102 kB

$ bun run test:e2e
16 specs · 0 failures
```

Lighthouse mobile audits live under `docs/tasks/phase-4/lighthouse/` — every
route ≥ 90 across Performance / Accessibility / Best Practices / SEO.

---

## Release lanes

The dashboard versions independently from the daemon. v0.1.0 was developed
against `claude-bridge` at `v1.0.4` (latest on `main` at release time). The
dashboard's read contract (the daemon-owned tables in `bridge.db`) is stable
across the daemon's `v0.5.x → v1.0.x` line; future daemon-breaking schema
changes will be published with a compatibility note in the corresponding
dashboard release.

If you bump the daemon to a future major (`v2.0.0`) and the dashboard cannot
read its `bridge.db`, the read pages render an "incompatible daemon schema"
banner and skip the affected queries. File an issue with the daemon version
and we'll cut a dashboard `v0.1.x` patch with the updated vendor.

---

## Cross-link

- Daemon repo: <https://github.com/hieutrtr/claude-bridge>
- Daemon README "Dashboard" section: TBD — owner adds the snippet from
  [`docs/RELEASE.md`](docs/RELEASE.md) after pushing this tag.

---

## Thanks

To the loop. 4 phases, 51 commits, 1462 tests, zero rollbacks.
