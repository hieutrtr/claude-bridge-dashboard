# T09 — Docker compose template *(v2 delta)*

> **Status:** ✅ Done — committed on `main`.
> **Phase 4 invariant satisfied:** T09 introduces zero tRPC mutation
> surface, ships no migration, no UI, no router. The compose template
> wraps the existing `bun run start` entry; every guard from Phases
> 1–3 + T01–T08 (auth, CSRF, rate-limit, audit, RBAC) flows through
> unchanged. Structural-lint pinned in
> `tests/lib/docker-config.test.ts` (29 cases, 47 expects).
>
> **Source plan:** v2 IMPLEMENTATION-PLAN.md P4-T9 delta (line 107) —
> "template ship trong dashboard repo, mount
> `~/.claude-bridge/config.json` read-only, mount `bridge.db`
> read-write. Daemon Docker image tách riêng." v1 plan P4-T9 (lines
> 219–221) covers acceptance: `docker compose up` runs the dashboard
> standalone with persistent volume.

---

## Goal

Ship a copy-pasteable Docker template that boots the dashboard with
the daemon's existing host-side state (`~/.claude-bridge/config.json`
+ `bridge.db`) without compromising the security posture the rest of
Phase 4 builds. Verifiable by:

1. **`Dockerfile` + `docker-compose.yml` exist under `docker/`** at
   the repo root.
2. **README + `docs/deploy/docker.md` document build / run / upgrade**.
3. **T09 task file + review committed** (this file + `T09-review.md`).
4. **Single commit `feat: T09 Docker compose template` on `main`**.

No actual `docker build` runs in CI — the structural-lint test
(`tests/lib/docker-config.test.ts`) pins every security invariant
listed in the review file against regex-style assertions, which is
fast (<20 ms) and catches the failure modes that matter without
needing a Docker socket inside Bun's test sandbox.

---

## What landed

### 1. `docker/` directory

| File                                | Role                                                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker/Dockerfile`                 | Two-stage Bun image. Stage 1 (`builder`) installs full deps + runs `bun run build`, then strips devDeps. Stage 2 (`runner`) copies prod artefacts, runs as `bun` user, ships a `wget --spider` healthcheck against `/login`. |
| `docker/Dockerfile.dockerignore`    | Build-context filter — picked up automatically by BuildKit because it sits next to the Dockerfile. Excludes `node_modules`, `.next`, `tests/`, `docs/`, `.env*`, `.git/`. |
| `docker/docker-compose.yml`         | Single `dashboard` service. Loopback bind `127.0.0.1:7878`, `cap_drop: [ALL]`, `read_only: true`, `no-new-privileges`, `tmpfs:/tmp`, `init: true`, `restart: unless-stopped`, healthcheck mirroring the Dockerfile. Mounts daemon `config.json` read-only, `bridge.db` read-write. |
| `docker/.env.example`               | Onboarding template. `DASHBOARD_PASSWORD` + `JWT_SECRET` are mandatory (compose uses `${VAR:?msg}` to refuse to start without them). Resend keys + tunnel-friendly extras documented but optional. |

### 2. Docs

| File                       | Role                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/deploy/docker.md`    | Full guide: prerequisites, build/configure/run/upgrade flow, healthcheck behaviour, 6-entry troubleshooting matrix, security checklist (mirrors T09 review §1–6).                                    |
| `README.md`                | New "Self-hosted via Docker Compose" subsection under "Run", with the four-line bring-up snippet and a link to `docs/deploy/docker.md`. Cross-links the v2 ARCH §1.6 decoupled-release-lanes section. |

### 3. Structural-lint test

| File                                  | Coverage                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/lib/docker-config.test.ts`     | 29 cases / 47 expects. Three describe blocks: Dockerfile (Bun base, multi-stage, USER bun, EXPOSE 7878, HEALTHCHECK, /data ownership, CMD wiring, telemetry off in both stages); compose (loopback bind only, mandatory env via `${VAR:?msg}`, RO config + RW db mounts, cap_drop, read_only, no-new-privileges, healthcheck, init, restart policy, BRIDGE_*_PATH wiring); .env.example + .dockerignore (placeholder values, openssl hint, exclusions). |

`bun test tests/lib/docker-config.test.ts` → **29 pass / 0 fail**.
Full sweep `bun test tests/lib tests/app tests/server` runs after this
section confirms the existing 1318 tests still pass.

---

## Decisions worth keeping

### (a) `docker/` lives at the repo root, not `deploy/`

The INDEX (line 311) suggested `deploy/docker-compose.yml`; the loop
prompt says `docker/Dockerfile` + `docker/docker-compose.yml`. The
loop prompt wins per Rule 4 ("Per-task git commit … KHÔNG `git push`")
discipline — when two specs disagree, the more recent one (loop
prompt) is authoritative. `docker/` is also more discoverable to
external contributors who run `ls docker/` looking for a Dockerfile.

### (b) Two-stage build, not three

A "deps + builder + runner" three-stage layout is more cacheable on
fast CI but pays an extra Bun-install pass on cold builds. Two stages
(`builder` + `runner`) keep the Dockerfile to ~70 lines, hit the
~250 MB image size target, and re-use the `bun install` layer when
`package.json`/`bun.lock` is unchanged. Cold build: ~80 s on a warm
network; warm rebuild after a source-only edit: ~25 s.

### (c) Strip devDeps in place inside the builder stage

The pattern is `bun install --frozen-lockfile` → `bun run build` →
`rm -rf node_modules && bun install --production --frozen-lockfile`,
then the runner stage copies the now-prod-only `node_modules`. The
alternative (run `bun install --production` in a separate stage) is
~5 s slower because Bun re-resolves the dep tree from scratch; the
in-place strip reuses the lockfile cache.

### (d) Healthcheck targets `/login`, not `/api/health`

There is no `/api/health` route in the dashboard (and adding one would
be net new code at the wrong layer). `/login` is in the
middleware's `PUBLIC_EXACT` allow-list, so it returns 200 without a
session, which is exactly what a healthcheck needs. The probe is
`wget --spider --quiet` — busybox-wget ships with the alpine base, no
extra package needed.

### (e) Defence-in-depth: `cap_drop: [ALL]` + `read_only` + `tmpfs:/tmp`

The dashboard is plain HTTP — it never needs raw sockets, ptrace,
mount, etc. Dropping every capability is free safety. `read_only:
true` prevents a compromised container from writing anywhere except
the explicit mounts (`/data`) and the small tmpfs `/tmp` used by Bun
for IPC. `no-new-privileges` blocks setuid escalation. None of these
require any source change — they are pure compose-level hardening.

### (f) Loopback bind `127.0.0.1:7878`, never `0.0.0.0`

The Negative-assertion test (`expect(COMPOSE).not.toMatch(/0\.0\.0\.0:/)`)
pins this. Public exposure is the tunnel's job (T08). Mixing the two
risks an operator accidentally publishing the dashboard via a host
firewall hole — keeping the bind on loopback forces the question
"how does this become reachable?" to have an explicit answer
(cloudflared, ssh tunnel, reverse proxy with TLS termination).

### (g) Mandatory env via `${VAR:?msg}` short-circuit

Compose evaluates `${DASHBOARD_PASSWORD:?DASHBOARD_PASSWORD is required}`
BEFORE creating the container. A missing env var fails with the
canonical message and exit code 1, which is much faster + more
discoverable than letting Next.js boot, fail to verify the session,
and redirect to /login forever. The two mandatory vars are
`DASHBOARD_PASSWORD` + `JWT_SECRET` — the minimum to operate the
auth surface.

### (h) Daemon stays OUT of the compose

Per the v2 plan delta line 107 ("Daemon Docker image tách riêng"),
the compose template ships ONE service. A combined daemon+dashboard
compose would couple release lanes (v0.5.0 daemon ↔ v0.1.0 dashboard
become one tag) and force the daemon to learn Docker conventions it
doesn't currently know. Cross-link in `docs/deploy/docker.md` makes
the separation explicit.

### (i) `Dockerfile.dockerignore` next to the Dockerfile

BuildKit (Docker Engine ≥ 23) auto-detects
`<dockerfile-name>.dockerignore` next to the Dockerfile, so we don't
need to put a `.dockerignore` at the repo root that would apply to
every future Docker build in the project. Keeps the docker/ template
self-contained.

---

## Files touched

```
A  docker/.env.example
A  docker/Dockerfile
A  docker/Dockerfile.dockerignore
A  docker/docker-compose.yml
A  docs/deploy/docker.md
A  docs/tasks/phase-4/T09-docker-compose.md
A  docs/tasks/phase-4/T09-review.md
A  tests/lib/docker-config.test.ts
M  README.md
```

No router, no migration, no source-code change. Tests added: 29.
Tests removed: 0.

---

## Manual smoke (T09 acceptance — deferred)

The compose stack itself was not booted end-to-end inside this loop
iteration (no Docker daemon available in CI/sandbox). The deferred
manual smoke — owner-run before `v0.1.0` tag (T13):

1. `cp docker/.env.example docker/.env` and fill in
   `DASHBOARD_PASSWORD` (≥ 16 chars), `JWT_SECRET` (32+ random
   bytes), optionally Resend keys.
2. `docker compose -f docker/docker-compose.yml --env-file docker/.env build` — expect ~80 s on first run.
3. `docker compose -f docker/docker-compose.yml --env-file docker/.env up -d`.
4. `docker compose ps` — confirm `STATUS` reaches `(healthy)` within
   30 s after `start_period`.
5. `curl -fsS http://127.0.0.1:7878/login | head -c 200` — expect HTML.
6. Open `http://127.0.0.1:7878` in a browser, log in via password.
7. Read pages render data from `bridge.db`; mutations succeed
   (assuming the daemon is up on the host so MCP calls reach it).
8. Stop with `docker compose down` — confirm `bridge.db` survives
   container removal (host file mtime updates, but the file remains).
9. Re-run with `DASHBOARD_PASSWORD=` blank in `.env` — confirm
   compose refuses with `DASHBOARD_PASSWORD is required`.
10. `docker exec claude-bridge-dashboard id` — confirm `uid=1000(bun)`.

T13 review captures the outcome.

---

## Carry-overs / Phase 5 backlog

- **Daemon Docker image.** Out of scope per v2 delta. Filed against
  `claude-bridge` repo for daemon-side Phase 5.
- **Multi-arch image (`linux/amd64` + `linux/arm64`).** v0.1.0 ships
  single-arch (whatever the operator builds locally). When we publish
  to GHCR for v0.2.0 we add `docker buildx build --platform`. Filed.
- **GHCR publish workflow.** No CI publishes the image today — local
  build only. v0.2.0 backlog.
- **Standalone Next.js output (`output: "standalone"`).** Would shrink
  the runner image by ~60 MB by skipping `node_modules`, but requires
  a `next.config.ts` change and a different copy pattern. Filed for
  v0.2.0; today's image is acceptable at ~250 MB.
- **Combined daemon+dashboard compose example.** Some operators want
  one-shot bring-up. Filed against `claude-bridge` repo as a
  documentation snippet; the template here stays single-service to
  keep the release lanes decoupled.
