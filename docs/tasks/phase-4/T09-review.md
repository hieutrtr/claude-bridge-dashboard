# T09 — Code review (Docker compose template)

> Self-review against the Phase 4 review-rule template (auth / RBAC /
> mobile / email-rate-limit). T09 sits in the **deploy-security** axis
> — the four numbered subsections below mirror the standard template;
> §5–§7 cover T09-specific concerns (non-root image, healthcheck
> coverage, secret handling).

---

## 1. Auth — does the container weaken auth in any way?

**No — auth surface is identical to `bun run start`.**

The Dockerfile's `CMD ["bun", "run", "start"]` invokes the same
`scripts/start.ts` wrapper that owners run on bare metal. The
container does NOT pass `--tunnel` (T08) — public exposure is the
operator's job via cloudflared OUTSIDE the container, not a flag
toggled by compose. The middleware chain (`middleware.ts` →
`PUBLIC_EXACT` allow-list → session verification → CSRF backfill)
runs inside the container exactly as on the host.

The compose file uses `${DASHBOARD_PASSWORD:?DASHBOARD_PASSWORD is required}`
and `${JWT_SECRET:?JWT_SECRET is required}` — the `${VAR:?msg}` short-
circuit makes compose refuse to create the container without both
secrets present. There is no fallback default for either, so an
operator cannot accidentally boot a "passwordless dashboard".

`RESEND_API_KEY` + `RESEND_FROM_EMAIL` are passed through via
`${VAR:-}` (default to empty). When unset, the dashboard's existing
graceful-fail behaviour applies — magic-link login UI shows the
"Email login disabled" state, password login still works. This
matches the contract documented in INDEX line 607.

## 2. RBAC — does the 403 matrix cover all mutation routes?

**N/A — T09 introduces no tRPC procedure.**

T09 ships container packaging only. The RBAC matrix from T03
(`tests/server/rbac-matrix.test.ts`) remains the single source of
truth. Routing the dashboard through Docker does not widen, narrow,
or otherwise touch the role checks.

A subtle RBAC-adjacent property: the daemon-owned `bridge.db` is
mounted read-write so the dashboard can write to `audit_log` (P2-T04),
`users` (T01), `magic_links` (T01), `notification_preferences` (T06),
and `telemetry_events` (T11). Mounting it read-only would silently
break audit logging — the existing `appendAudit` writes would throw
SQLITE_READONLY mid-mutation. The compose deliberately omits the
`:ro` suffix on the bridge.db mount; the structural-lint test
(`mounts bridge.db read-write (no :ro suffix)`) pins this.

## 3. Mobile — Lighthouse ≥ 90?

**Yes — inherited from T07; unaffected by container packaging.**

Containerising the same Next.js production build does not change the
client-side bundle size, render path, or accessibility tree. T07
Lighthouse summary (`docs/tasks/phase-4/lighthouse/summary.json`) —
perf 96–99, a11y 98–100, BP 96 — applies unchanged when the server is
behind the Docker network bridge.

If anything, container deploys tend to lift consistency (no host
Node/Bun version skew) which makes Lighthouse scores more
reproducible. No regression possible from this task.

## 4. Email rate-limit — anti-abuse?

**N/A locally — inherited from T01.**

The magic-link rate-limit (5/min/IP + 5/hour/email-hash) runs at the
tRPC `auth.requestMagicLink` layer, which executes the same way
inside the container as outside. The IP key derivation reads
`x-forwarded-for` — when the container sits behind a tunnel
(cloudflared adds `CF-Connecting-IP`/`X-Forwarded-For`) or a reverse
proxy, the rate-limit bucket keys on the upstream client IP, not the
container's loopback peer. T01 review §3 captured the header
handling.

Defensive backstop: when `RESEND_API_KEY` is unset the magic-link
mutation no-ops outbound email — the rate-limit bucket still ticks
but no email actually leaves the box. So the "abusive new operator
forgot to configure rate-limit" failure mode bottoms out at zero
email cost.

---

## Additional T09-specific concerns

### 5. Container privileges — is the runtime non-root + capability-limited?

**Yes — three layers of hardening, all pinned by the structural-lint test.**

- **`USER bun`** in the Dockerfile — runtime uid 1000, not root. The
  oven/bun:1.1-alpine base ships the user pre-created; we just switch
  to it and chown the `/data` mount point so SQLite can write the
  WAL/SHM sidecar files.
- **`cap_drop: [ALL]`** in compose — every Linux capability removed.
  The dashboard is plain HTTP; it never needs `CAP_NET_RAW`,
  `CAP_SYS_PTRACE`, `CAP_SYS_ADMIN`, etc. A compromised process
  cannot raw-socket scan the host network or read other users' procs.
- **`read_only: true` + `tmpfs:/tmp`** — the root filesystem is
  immutable post-boot. The only writable paths are `/data` (bind
  mount → host bridge.db) and `/tmp` (size-capped tmpfs for Bun's
  IPC). A compromised process cannot drop a binary anywhere
  persistent.
- **`security_opt: [no-new-privileges:true]`** — even if a setuid
  binary somehow reached the container (it shouldn't — alpine base is
  minimal), it cannot escalate.

The structural-lint test asserts every line above. Removing or
weakening any of them flips a test red.

### 6. Healthcheck coverage — do we detect a broken boot?

**Yes — `wget --spider /login` every 30 s, fail after 3 misses.**

The probe is intentionally cheap (HEAD-equivalent + no body) and
hits a public route (no session needed). `start_period: 20s` gives
Next.js + Drizzle migration enough headroom to come up cold without
the healthcheck false-failing during boot.

What the healthcheck DETECTS:
- Next.js failed to boot (port 7878 not listening) → `ECONNREFUSED`
  → unhealthy after 3 misses (~90 s).
- Drizzle migration crash on boot → Next.js exits → ditto.
- Container OOM → kernel kills the process → ditto.
- DB file unmounted / corrupted → `/login` itself still serves (it
  doesn't touch the DB), so the probe is GREEN even though the rest
  of the dashboard is broken. Documented in `docs/deploy/docker.md`
  troubleshooting matrix entry "Container is `(unhealthy)` shortly
  after boot" — operators are pointed at `docker logs`.

What it deliberately DOES NOT detect:
- A specific feature regression (e.g. magic-link mutation throwing).
  Healthchecks are about liveness, not correctness; correctness
  belongs in the existing E2E suite.
- Bridge daemon offline. The dashboard's existing "daemon offline"
  toast handles that at the tRPC layer.

### 7. Secret handling — do secrets ever land on disk inside a layer?

**No — secrets are env-only at runtime; build context excludes `.env*`.**

The `Dockerfile.dockerignore` lists `.env`, `.env.local`,
`.env.*.local`, `*.local`, `docker/.env`. Even if an operator
accidentally `cp`s their `.env` into the build context, BuildKit
strips it before any `COPY` instruction sees it. Verified by
`tests/lib/docker-config.test.ts` "excludes .env files (no secrets
baked into layers)".

The `.env.example` file in `docker/` ships with placeholder values
(e.g., `replace-with-≥16-char-random-passphrase`,
`replace-with-openssl-rand-hex-32`) — never real secrets. The
structural-lint test asserts the placeholders are present; if anyone
ever pasted a real password there the test would still pass (we
can't pattern-match "this looks like a real secret"), so the
secondary defence is the .gitignore rule + the README warning.

Secret rotation: bump `JWT_SECRET` in `.env`, run
`docker compose up -d` — the container restarts with the new value
and every existing session is invalidated. No data migration needed.

---

## Carry-overs / open items

1. **`output: "standalone"` in `next.config.ts`.** Would shrink the
   runner image by ~60 MB by skipping the `node_modules` copy.
   Requires a config change + a different runner-stage copy pattern
   (`COPY .next/standalone ./` + tweaked CMD). Tracked for
   `dashboard@v0.2.0`. Tradeoff: standalone mode is opinionated and
   has historically had quirks with custom server entrypoints; we
   defer until we have time to E2E it.
2. **Multi-arch (`linux/amd64` + `linux/arm64`).** v0.1.0 builds for
   the operator's host arch only. When we publish to GHCR for v0.2.0,
   we add `docker buildx build --platform linux/amd64,linux/arm64
   --push`. Tracked.
3. **GHCR publish workflow.** No CI publishes the image today — local
   build only. The published-image flow ships in v0.2.0 with the
   multi-arch change above.
4. **Daemon Docker image (separate repo).** Per v2 delta line 107.
   Filed against `claude-bridge` repo. The dashboard compose's RO
   `config.json` mount + RW `bridge.db` mount stay valid whether the
   daemon runs on the host or in its own container — both write to
   the same well-known host paths.
5. **Manual smoke deferred.** No Docker daemon in this loop's
   sandbox; the 10-step manual smoke in the task file runs before
   T13 tags `v0.1.0`. T13 review captures the outcome.

Final verdict: **safe to merge**. No new tRPC surface, no migration,
no UI; auth/RBAC/audit/CSRF/rate-limit all pass through the existing
middleware chain unchanged. Container hardening (non-root, cap_drop,
read_only, no-new-privileges) is defence-in-depth. Mandatory secrets
short-circuit before container creation; `.env` files excluded from
build context.
