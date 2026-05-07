# @claude-bridge/dashboard

Web dashboard for [claude-bridge](https://github.com/hieutrtr/claude-bridge) — observe
agents, tasks, loops, schedules, and cost from a browser.

This dashboard ships as a **standalone repo**, decoupled from the `claude-bridge`
daemon. Each tagged release (`v0.1.0`, `v0.2.0`, …) is installable independently. The
daemon runs as its own process and the dashboard is a thin read/write client over the
shared `~/.claude-bridge/bridge.db` SQLite + the daemon's MCP socket.

> **Status:** **v0.1.0 GA** — Phases 1–4 complete. Tag is local-only until the owner
> pushes after review. See [`CHANGELOG.md`](CHANGELOG.md) and
> [`RELEASE-NOTES-v0.1.0.md`](RELEASE-NOTES-v0.1.0.md) for the full feature set and
> upgrade notes.

## Features (v0.1.0)

- **Phase 1 — Read-only MVP.** Agents grid, agent detail, tasks list/detail, JSONL
  transcript viewer, SSE live updates, cost analytics, memory tab, dark/light theme.
- **Phase 2 — Actions.** Dispatch task (⌘K), kill task, audit log + viewer, loop
  approve/reject inline, rate-limit + CSRF middleware, MCP connection pool, optimistic
  UI with rollback, `<DangerConfirm>` for destructive actions.
- **Phase 3 — Loops & schedules.** Loops list/detail, start/cancel loop dialog,
  schedules CRUD, cron picker + cost forecast, run history drawer, E2E Playwright
  coverage.
- **Phase 4 — Polish & multi-user.** Magic-link auth via Resend, user management,
  RBAC (owner/member) with 48-cell 403 matrix, multi-user cost view, ⌘K command
  palette, notification preferences + email digest, mobile responsive (Lighthouse
  ≥ 90), cloudflared tunnel + Docker compose deploy, AA-contrast theme polish,
  privacy-first telemetry opt-in, Vietnamese + English i18n scaffold.

See [`docs/tasks/phase-{1,2,3,4}/PHASE-*-COMPLETE.md`](docs/tasks/) for per-phase
sign-offs and [`docs/web-dashboard/v2/ARCHITECTURE.md`][arch] in the daemon repo for
the load-bearing security and architecture rationale.

[arch]: https://github.com/hieutrtr/claude-bridge/blob/main/docs/web-dashboard/v2/ARCHITECTURE.md

## Install

Requires Bun ≥ 1.1.

```bash
git clone https://github.com/hieutrtr/claude-bridge-dashboard
cd claude-bridge-dashboard
git checkout v0.1.0           # pin to the GA tag
bun install
```

The dashboard expects a running `claude-bridge` daemon on the same machine. It reads
`~/.claude-bridge/config.json` to discover the daemon's SQLite database and socket
endpoint. Compatible daemon: `claude-bridge ≥ v1.0.0` (see
[Compatibility](#compatibility) below).

## Configure

At minimum, set:

```bash
export JWT_SECRET=$(openssl rand -base64 48)
export DASHBOARD_PASSWORD='use-at-least-16-chars-not-the-default'
```

Magic-link auth (recommended once you invite a second user) requires Resend:

```bash
export RESEND_API_KEY=re_xxx
export RESEND_FROM_EMAIL='dashboard@your-domain.example'   # or the *.resend.dev free-tier sender
```

See the [Environment variables](#environment-variables) matrix for every knob.

## Run

```bash
bun run dev               # development (hot reload, default :3000)
bun run build             # production build (Next.js)
bun run start             # production server (binds 127.0.0.1:7878)
bun run start:tunnel      # production + cloudflared public URL
```

### Public access via cloudflared tunnel

When you need to reach the dashboard from a phone or another network, run
`bun run start:tunnel` to spawn a [cloudflared](https://github.com/cloudflare/cloudflared)
ephemeral tunnel alongside `next start`. The wrapper prints a `*.trycloudflare.com`
URL and a QR code once the tunnel is live; share it with whoever should reach the
dashboard, and tear both processes down with a single Ctrl-C.

The flag refuses to start unless the env is safe to expose:

| Env var               | Why required                                    |
| --------------------- | ----------------------------------------------- |
| `RESEND_API_KEY`      | Magic-link auth must be reachable               |
| `RESEND_FROM_EMAIL`   | Resend rejects requests without a sender        |
| `DASHBOARD_PASSWORD`  | ≥ 16 chars, not a default placeholder           |

You also need `cloudflared` on your `PATH` — install via
`brew install cloudflared` (macOS), the deb/rpm packages at
[pkg.cloudflare.com](https://pkg.cloudflare.com/) (Linux), or
`winget install --id Cloudflare.cloudflared` (Windows). The dashboard does not bundle
the binary.

See [`docs/deploy/tunnel.md`](docs/deploy/tunnel.md) for the install flow, security
checklist, and troubleshooting tips.

### Self-hosted via Docker Compose

Prefer Docker when you want a frozen version, restart-on-reboot, or to ship a
reproducible install to a teammate. The dashboard repo ships a template under
`docker/`:

```bash
cp docker/.env.example docker/.env       # set DASHBOARD_PASSWORD + JWT_SECRET
docker compose -f docker/docker-compose.yml --env-file docker/.env up -d
```

The container binds `127.0.0.1:7878`, mounts the daemon's
`~/.claude-bridge/config.json` read-only, mounts `bridge.db` read-write, runs as a
non-root `bun` user with capabilities dropped, and ships a `wget`-based healthcheck
against `/login`. Upgrade is `git checkout <new-tag> && docker compose build && up -d`.
Full walkthrough — including `BRIDGE_HOST_DB` overrides, troubleshooting, and the
security checklist — in [`docs/deploy/docker.md`](docs/deploy/docker.md).

The daemon itself runs **outside** the container (host process or its own image). The
two release lanes stay independent per [v2 ARCHITECTURE §1.6][arch].

## Connect to the daemon

The dashboard auto-discovers a local `claude-bridge` daemon by reading
`~/.claude-bridge/config.json`. Expected schema:

```json
{
  "version": 1,
  "daemon": {
    "db_path": "~/.claude-bridge/bridge.db",
    "socket": "~/.claude-bridge/bridge.sock"
  },
  "dashboards": [
    { "version": "v0.1.0", "path": "~/.claude-bridge/dashboards/v0.1.0", "default": true }
  ]
}
```

If `~/.claude-bridge/config.json` is absent the dashboard falls back to the default
paths above and prints a warning. Read pages still render against `bridge.db` when the
daemon is offline; mutations surface a `daemon offline` toast and skip MCP. See
`src/lib/discovery.ts` for the loader.

## Compatibility

| Component       | Required                                                               |
| --------------- | ---------------------------------------------------------------------- |
| Bun runtime     | `≥ 1.1`                                                                |
| Node engine     | n/a (Bun-only — `node` is not used at runtime)                         |
| `claude-bridge` daemon | `≥ v1.0.0` — the `bridge.db` schema introduced in the daemon's `v0.5.x` line is the contract this dashboard reads. The daemon owns `agents`, `tasks`, `loops`, `schedules`; the dashboard owns `audit_log`, `users`, `magic_links`, `notification_preferences`, `telemetry_events` (separate migrations under `src/db/migrations/`). |
| Browser         | Latest Chrome / Firefox / Safari. Mobile Safari + Chrome on iOS verified at iPhone width 390px. |

The dashboard does **not** modify daemon-owned tables. Daemon upgrades that change
`agents`/`tasks`/`loops`/`schedules` shape are tracked via a vendored Drizzle schema
(`src/db/schema.ts`) — re-introspect with `bun run db:introspect` when the daemon
ships a breaking schema change.

## Security model

- **Auth.** Owner password (env-driven) + invited members via magic-link (Resend).
  Sessions are 7-day HS256 JWTs in an httpOnly cookie. Magic-link tokens are
  single-use, 15-minute TTL, hashed-at-rest.
- **RBAC.** `owner` / `member` enforced at the tRPC middleware layer. The 48-cell 403
  matrix (`tests/server/rbac-matrix.test.ts`) is the canonical specification.
- **CSRF.** Double-submit cookie pattern (`src/server/csrf-guard.ts`).
- **Rate limit.** Per-user 30/min for mutations, 5/min/IP for login + magic-link
  request, 5/hour/email-hash anti-enumeration on magic-link request.
- **Audit log.** Every mutation writes one row before returning. Free-text PII never
  echoed — emails store as `email_hash`, magic-link tokens as `tokenIdPrefix`,
  preference changes as `{ changes: [...keys] }` only.
- **Telemetry.** Default OFF. Anonymous, install-scoped (no `user_id`), PII scrubber
  on `event_name`. No upload endpoint until owner sets `TELEMETRY_ENDPOINT`.

Full rationale in [v2 ARCHITECTURE §6 + §10][arch].

## Environment variables

| Env var                  | Default       | Used by                  | Failure mode if missing                                                                                                          |
| ------------------------ | ------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`             | _(required)_  | Session signing          | Login fails; middleware redirects every request to `/login`.                                                                    |
| `DASHBOARD_PASSWORD`     | _(required)_  | Owner-env login          | Password tab shows "not configured". Magic-link still works once Resend is set up.                                              |
| `RESEND_API_KEY`         | unset         | Magic-link, email digest | Magic-link UI shows "Email login disabled — set RESEND_API_KEY". Owner-env password login still works. Email digest is no-op.  |
| `RESEND_FROM_EMAIL`      | unset         | Magic-link, email digest | Magic-link UI shows "Email sender not configured".                                                                              |
| `OWNER_EMAIL`            | `owner@local` | Owner-env user row       | Default used; warning logged once.                                                                                              |
| `AUDIT_IP_HASH_SALT`     | `JWT_SECRET`  | Audit log IP hashing     | Falls back to `JWT_SECRET`.                                                                                                     |
| `BRIDGE_DASHBOARD_ORIGIN`| `http://127.0.0.1:7878` | CSRF Origin check | Origin mismatches return 403.                                                                                                   |
| `TELEMETRY_ENDPOINT`     | null          | Telemetry upload (deferred to v0.2.0) | No-op locally; rows accumulate in `telemetry_events` until uploaded manually.                                       |
| `BRIDGE_LOCALE_DEFAULT`  | `en`          | i18n initial cookie      | Defaults to `en`. Switcher persists user choice via `bridge_locale` cookie.                                                     |
| `BRIDGE_DB_PATH`         | discovered    | All phases               | Discovery falls back to `~/.claude-bridge/bridge.db`.                                                                           |
| `BRIDGE_CONFIG_PATH`     | discovered    | Docker mount             | Discovery falls back to `~/.claude-bridge/config.json`.                                                                         |

**Refuse-to-start gates** (only `bun run start:tunnel`): `RESEND_API_KEY`,
`RESEND_FROM_EMAIL`, `DASHBOARD_PASSWORD` ≥ 16 chars + non-default. The wrapper exits
1 with a clear error if any of these is missing.

## Troubleshooting

| Symptom                                              | Likely cause                                                                                  | Fix                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/login` returns 500 on first POST                   | `JWT_SECRET` unset                                                                            | `export JWT_SECRET=$(openssl rand -base64 48)` and restart.                                  |
| Pages render empty / `agents.list` returns `[]`      | Daemon DB not discovered                                                                      | Check `~/.claude-bridge/config.json` exists, or set `BRIDGE_DB_PATH` to the actual path.     |
| Mutations fail with "daemon offline" toast           | MCP socket unreachable                                                                        | Start the daemon (`claude-bridge start`) and retry. Read pages keep working in offline mode. |
| Magic-link email never arrives                       | `RESEND_API_KEY` unset, `RESEND_FROM_EMAIL` not on a verified domain, or rate limit (5/hour/email-hash) | Check Resend dashboard logs; verify the sender domain; wait the rate-limit window.    |
| `start:tunnel` exits with "default password"         | `DASHBOARD_PASSWORD` is empty, < 16 chars, or matches the install-time placeholder            | Generate a fresh strong password (`openssl rand -base64 24`).                                |
| `cloudflared: command not found`                     | Binary not on `PATH`                                                                          | Install per the [tunnel docs](docs/deploy/tunnel.md).                                        |
| `/users` returns 403 for the only logged-in user     | Owner role assignment broke (rare — only after manual DB edits)                               | Run `bun run scripts/promote-owner.ts <email>` to re-assign `role='owner'`.                  |
| Lighthouse score below 90 after a custom theme       | Heavy custom CSS / un-minified assets                                                         | Run `bun run lighthouse:mobile` and inspect the report under `docs/tasks/phase-4/lighthouse/`.|
| Tests fail with `database is locked`                 | Concurrent test runs against the same `bridge.db`                                             | Use the test fixture (`tests/e2e/.fixture/`) or set `BRIDGE_DB_PATH` per-run.                |

For deeper debugging, set `DEBUG=claude-bridge:*` and re-run; logs print to stderr.

## Repository layout

```
app/                Next.js app router routes
src/
  components/       UI primitives + composed views
  db/               Drizzle ORM schema + migrations (dashboard-owned tables)
  i18n/             i18next setup, locale resolver, en + vi message dictionaries
  lib/              Discovery, config loading, helpers
  server/           tRPC routers, RBAC, CSRF, rate-limit, audit, MCP pool
docker/             Docker compose template + .env.example
docs/
  deploy/           tunnel.md, docker.md
  tasks/            Per-phase task specs + reviews + sign-offs
scripts/
  introspect.ts     Generate Drizzle schema from a sample bridge.db
  start.ts          Wrapper that powers `bun run start[:tunnel]`
  email-digest.ts   Hourly cron for notification email digests
  lighthouse-mobile.ts  Lighthouse mobile audit runner
tests/
  app/              Component tests (Bun + Testing Library)
  lib/              Unit tests
  server/           Router + middleware tests
  e2e/              Playwright specs
drizzle.config.ts   Drizzle config
middleware.ts       Auth + CSRF Next.js middleware
playwright.config.ts
package.json        Standalone — not a Bun workspace member
```

## Development

```bash
bun install
bun run dev                           # localhost:3000 with hot reload
bun run typecheck                     # tsc --noEmit
bun run test                          # Bun runner (unit + integration + component)
bun run test:e2e                      # Playwright
bun run lighthouse:mobile             # mobile audit (writes to docs/tasks/phase-4/lighthouse/)
bun run db:introspect                 # regenerate src/db/schema.ts from a sample bridge.db
```

## Releasing

See [`docs/RELEASE.md`](docs/RELEASE.md) for the full process. TL;DR:

```bash
bun run test && bun run build && bun run test:e2e
git tag -a v0.X.0 -m "..."
git push origin v0.X.0   # only the owner does this; the loop never pushes
```

## Roadmap (v0.2.0)

- Onboarding wizard
- Lighthouse-CI gate (perf budget assertion)
- Browser push notifications (full implementation)
- ICU plural rules + a third locale
- Dashboard-driven daemon health probe (live socket status indicator)
- `bun run sync-schema` for daemon-side breaking changes

## License

MIT.
