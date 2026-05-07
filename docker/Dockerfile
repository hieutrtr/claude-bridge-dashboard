# syntax=docker/dockerfile:1.7
#
# Multi-stage Bun image for @claude-bridge/dashboard.
# Phase 4 — T09 (v2 delta): self-hosted Docker template.
#
# Build:
#   docker build -f docker/Dockerfile -t claude-bridge-dashboard:dev .
#
# Run (prefer docker compose — see docker/docker-compose.yml):
#   docker run --rm \
#     -p 127.0.0.1:7878:7878 \
#     -v $HOME/.claude-bridge/config.json:/data/config.json:ro \
#     -v $HOME/.claude-bridge/bridge.db:/data/bridge.db \
#     -e DASHBOARD_PASSWORD=... -e JWT_SECRET=... \
#     claude-bridge-dashboard:dev
#
# Image size target: ~250 MB compressed (Bun alpine base ~80 MB +
# .next + production node_modules). Tracked manually — no CI gate.

# -----------------------------------------------------------------
# Stage 1 — builder: install full deps and run `next build`.
# -----------------------------------------------------------------
FROM oven/bun:1.1-alpine AS builder
WORKDIR /app

# Bun lockfile + manifest first so the layer caches across source
# edits that don't touch dependencies.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the rest of the source for the Next.js production build.
COPY tsconfig.json next.config.ts postcss.config.mjs ./
COPY app ./app
COPY src ./src
COPY scripts ./scripts
COPY middleware.ts ./middleware.ts

ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# Strip dev dependencies in place — saves ~80 MB in the runtime image.
RUN rm -rf node_modules && bun install --production --frozen-lockfile

# -----------------------------------------------------------------
# Stage 2 — runner: minimal image, non-root user, healthcheck.
# -----------------------------------------------------------------
FROM oven/bun:1.1-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DASHBOARD_PORT=7878 \
    BRIDGE_DB_PATH=/data/bridge.db \
    BRIDGE_CONFIG_PATH=/data/config.json

# /data is the bind-mount target for the daemon-owned bridge.db and
# config.json. Pre-create with bun ownership so the non-root runtime
# can read+write without a host-side chown dance.
RUN mkdir -p /data && chown -R bun:bun /data

# Copy the runtime artefacts only — no devDeps, no test fixtures.
# `oven/bun:1.1-alpine` already has a non-root `bun` user (uid 1000).
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
COPY --from=builder --chown=bun:bun /app/bun.lock ./bun.lock
COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/.next ./.next
COPY --from=builder --chown=bun:bun /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=bun:bun /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=bun:bun /app/middleware.ts ./middleware.ts
COPY --from=builder --chown=bun:bun /app/app ./app
COPY --from=builder --chown=bun:bun /app/src ./src
COPY --from=builder --chown=bun:bun /app/scripts ./scripts

USER bun
EXPOSE 7878

# Healthcheck: /login is a public route (middleware allows it pre-auth)
# so we can verify the Next.js server is serving HTTP without exposing
# any session-bearing path. busybox `wget --spider` ships with the
# alpine base — no extra package needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --spider --quiet "http://127.0.0.1:${DASHBOARD_PORT}/login" || exit 1

CMD ["bun", "run", "start"]
