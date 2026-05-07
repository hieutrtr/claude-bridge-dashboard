# Docker — self-hosted deploy

> Phase 4 — T09 (v2 delta). Ships the dashboard as a single container
> that mounts the daemon-owned `bridge.db` and `config.json` from the
> host. The daemon itself runs OUTSIDE this container (on the host or
> in its own image; the v2 plan keeps the two release lanes
> independent — see `docs/web-dashboard/v2/IMPLEMENTATION-PLAN.md`
> §1.6).
>
> If you only need a single-machine, hand-managed install, prefer
> `bun run start` directly — Docker is for multi-host, restart-policy,
> or "ship a frozen version to a teammate" use-cases.

## What's in `docker/`

```
docker/
  Dockerfile                 # multi-stage Bun build, non-root, healthcheck
  Dockerfile.dockerignore    # build-context filter (BuildKit picks it up)
  docker-compose.yml         # dashboard service + bind mounts + secrets
  .env.example               # template — copy to .env, fill in secrets
```

`Dockerfile.dockerignore` is detected automatically by BuildKit because
it lives next to the Dockerfile. If you build with the legacy builder
(BuildKit off), copy it to a top-level `.dockerignore` first.

## Prerequisites

- Docker Engine ≥ 24 (BuildKit on by default).
- A running `claude-bridge` daemon on the host with state in
  `~/.claude-bridge/{config.json,bridge.db}`. Override the host paths
  via `BRIDGE_HOST_CONFIG` / `BRIDGE_HOST_DB` in `.env` if your daemon
  stores state elsewhere.
- ~250 MB free for the image, ~50 MB working memory while running.

## Build

```bash
# From the dashboard repo root.
docker compose -f docker/docker-compose.yml build
```

The build runs entirely inside Bun (`oven/bun:1.1-alpine`). No host
toolchain required beyond Docker. First build takes 60–90 s on a warm
network; subsequent builds re-use the `bun install` layer if
`package.json`/`bun.lock` did not change.

## Configure

```bash
cp docker/.env.example docker/.env
$EDITOR docker/.env   # set DASHBOARD_PASSWORD, JWT_SECRET, RESEND_*
```

`docker/.env` is gitignored (matched by the repo-level `.env.*`
pattern). Never commit it. Compose refuses to start with the canonical
error `DASHBOARD_PASSWORD is required` if either of the two mandatory
secrets is missing — that is the `${VAR:?msg}` form in the compose
file working as designed.

## Run

```bash
docker compose -f docker/docker-compose.yml --env-file docker/.env up -d
docker compose -f docker/docker-compose.yml logs -f dashboard
```

The container binds `127.0.0.1:7878` on the host. Public exposure is
the tunnel's job — set up cloudflared OUTSIDE the container (run
`bun run start --tunnel` on the host pointing at port 7878, or use a
managed tunnel that forwards to `127.0.0.1:7878`). See
[`tunnel.md`](./tunnel.md) for the security checklist.

## Healthcheck

The container ships with a `wget --spider` probe against
`/login` (a public route — no auth required). The probe runs every
30 s, fails after 3 misses (≈ 90 s). `docker ps` surfaces the verdict
in the `STATUS` column (`healthy` / `unhealthy`); a restart-policy of
`unless-stopped` (the default in the compose file) brings the
container back up automatically on host reboot.

## Upgrade

When a new dashboard release lands (e.g. `v0.1.1`):

```bash
git fetch && git checkout v0.1.1
docker compose -f docker/docker-compose.yml build --pull
docker compose -f docker/docker-compose.yml up -d
```

The `bridge.db` mount survives the container swap — there's no
in-container state to migrate. New SQL migrations under
`src/db/migrations/` run on next boot via the existing migration
runner (no `docker exec` step needed).

To roll back, check out the previous tag and rebuild. The DB schema is
forward-compatible inside a minor; cross-major upgrades document any
manual steps in their CHANGELOG entry.

## Troubleshooting

**`Error: cannot start service dashboard: DASHBOARD_PASSWORD is required`**
You skipped the `cp .env.example .env` step (or left the placeholder
blank). The compose `${VAR:?msg}` form short-circuits before the
container even starts.

**Container is `(unhealthy)` shortly after boot.**
Tail the logs (`docker compose logs dashboard`) — the most common
cause is a missing or wrong `BRIDGE_DB_PATH` mount. The healthcheck
itself only fetches `/login`, so a `503` from `/login` means Next.js
itself failed to boot, usually because a Drizzle migration could not
run (DB file unreadable, schema mismatch).

**`bind source path does not exist: /Users/.../bridge.db`**
The host path you set in `BRIDGE_HOST_DB` doesn't exist yet — start
the daemon at least once so it creates `bridge.db`, then bring the
container back up.

**Magic-link login times out.**
You haven't set `RESEND_API_KEY` / `RESEND_FROM_EMAIL`. The container
boots fine without them but the email-login UI shows a graceful
disabled state. Set both and `docker compose restart dashboard`.

**Container starts as root after image rebuild.**
The Dockerfile pins `USER bun`. If you customised the image or
inherited from a non-bun base, re-add the line. Verify with
`docker exec claude-bridge-dashboard id` — should print `uid=1000(bun)`.

**SQLite "database is locked" after a daemon process crash.**
WAL mode normally handles concurrent writers, but a hard kill can
leave a stale lock. Stop the container, run
`sqlite3 ~/.claude-bridge/bridge.db 'PRAGMA wal_checkpoint(TRUNCATE);'`,
and bring the container back. The dashboard will reopen the WAL
cleanly.

## Security checklist (before exposing)

1. `DASHBOARD_PASSWORD` ≥ 16 chars and not a placeholder
   (`password`, `changeme`, the example string in `.env.example`,
   etc.). The tunnel wrapper enforces this; `docker compose` does not
   — verify by hand before pointing a tunnel at the container.
2. `JWT_SECRET` is 32+ random bytes. Anything shorter weakens session
   signing.
3. `RESEND_API_KEY` set so magic-link is reachable. Without it, the
   only entry path is `DASHBOARD_PASSWORD`, which becomes the
   brute-force surface.
4. Host firewall blocks port 7878 from the public internet — the
   compose binds `127.0.0.1` only, but a misconfigured firewall could
   still publish the underlying NAT.
5. `bridge.db` host file mode is `0600` (owner-only). The container
   runs as uid 1000; if your host owner uses a different uid you
   may need `chown 1000 bridge.db` once.
6. The image runs as a non-root `bun` user with `cap_drop: [ALL]`,
   `read_only: true`, and `no-new-privileges`. Don't add `privileged:
   true` or capabilities back without a documented reason.
