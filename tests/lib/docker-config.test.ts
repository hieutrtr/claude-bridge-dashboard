// P4-T09 — Structural lint of the Docker template.
//
// We do not boot Docker inside CI (image build is ~80 s and requires
// the daemon, neither of which fits the unit-test loop). Instead we
// assert that the Dockerfile + compose file encode the security
// invariants T09 review §1–6 lists — non-root user, healthcheck,
// loopback bind, read-only root FS, capability drop, secrets via env.
// A regression in any of these would silently weaken the deploy
// surface, so this file pins them as code.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DOCKERFILE = readFileSync(
  resolve(REPO_ROOT, "docker/Dockerfile"),
  "utf8",
);
const COMPOSE = readFileSync(
  resolve(REPO_ROOT, "docker/docker-compose.yml"),
  "utf8",
);
const ENV_EXAMPLE = readFileSync(
  resolve(REPO_ROOT, "docker/.env.example"),
  "utf8",
);
const DOCKERIGNORE = readFileSync(
  resolve(REPO_ROOT, "docker/Dockerfile.dockerignore"),
  "utf8",
);

describe("docker/Dockerfile — multi-stage Bun image", () => {
  it("uses the Bun alpine base for both stages", () => {
    const fromLines = DOCKERFILE.match(/^FROM .+/gm) ?? [];
    expect(fromLines.length).toBeGreaterThanOrEqual(2);
    for (const line of fromLines) {
      expect(line).toMatch(/^FROM oven\/bun:1\.1-alpine/);
    }
  });

  it("declares a builder stage that runs `bun run build`", () => {
    expect(DOCKERFILE).toMatch(/AS builder\b/);
    expect(DOCKERFILE).toMatch(/RUN bun run build/);
  });

  it("strips dev dependencies before the runtime layer", () => {
    expect(DOCKERFILE).toMatch(/bun install --production --frozen-lockfile/);
  });

  it("declares a runner stage with NODE_ENV=production", () => {
    expect(DOCKERFILE).toMatch(/AS runner\b/);
    expect(DOCKERFILE).toMatch(/NODE_ENV=production/);
  });

  it("runs as the non-root `bun` user", () => {
    expect(DOCKERFILE).toMatch(/^USER bun\b/m);
  });

  it("exposes only port 7878 (the dashboard port)", () => {
    const exposeLines = DOCKERFILE.match(/^EXPOSE .+/gm) ?? [];
    expect(exposeLines).toEqual(["EXPOSE 7878"]);
  });

  it("ships a HEALTHCHECK against the public /login route", () => {
    expect(DOCKERFILE).toMatch(/^HEALTHCHECK /m);
    expect(DOCKERFILE).toMatch(/wget --spider .+\/login/);
  });

  it("creates the /data mount point and chowns it to bun", () => {
    expect(DOCKERFILE).toMatch(/mkdir -p \/data/);
    expect(DOCKERFILE).toMatch(/chown -R bun:bun \/data/);
  });

  it("starts the wrapper via `bun run start`", () => {
    expect(DOCKERFILE).toMatch(/CMD \["bun", "run", "start"\]/);
  });

  it("disables Next.js telemetry in both build + runtime stages", () => {
    const occurrences = DOCKERFILE.match(/NEXT_TELEMETRY_DISABLED=1/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

describe("docker/docker-compose.yml — security posture", () => {
  it("references the multi-stage Dockerfile", () => {
    expect(COMPOSE).toMatch(/dockerfile:\s*docker\/Dockerfile/);
  });

  it("publishes the port on loopback only (no 0.0.0.0)", () => {
    const portLine = COMPOSE.match(/- "127\.0\.0\.1:.+:7878"/);
    expect(portLine).not.toBeNull();
    // Negative — ensure no 0.0.0.0 bind ever ships in the template.
    expect(COMPOSE).not.toMatch(/0\.0\.0\.0:/);
  });

  it("requires DASHBOARD_PASSWORD and JWT_SECRET via the ${VAR:?msg} form", () => {
    expect(COMPOSE).toMatch(/DASHBOARD_PASSWORD:\s*\$\{DASHBOARD_PASSWORD:\?/);
    expect(COMPOSE).toMatch(/JWT_SECRET:\s*\$\{JWT_SECRET:\?/);
  });

  it("mounts config.json read-only", () => {
    expect(COMPOSE).toMatch(/config\.json[}]?:\/data\/config\.json:ro/);
  });

  it("mounts bridge.db read-write (no :ro suffix)", () => {
    const dbMount = COMPOSE.match(/bridge\.db[}]?:\/data\/bridge\.db([^"]*)"/);
    expect(dbMount).not.toBeNull();
    expect(dbMount?.[1] ?? "").not.toMatch(/:ro/);
  });

  it("drops every kernel capability", () => {
    expect(COMPOSE).toMatch(/cap_drop:\s*\n\s*- ALL/);
  });

  it("enables read-only root filesystem", () => {
    expect(COMPOSE).toMatch(/read_only:\s*true/);
  });

  it("sets no-new-privileges:true", () => {
    expect(COMPOSE).toMatch(/no-new-privileges:true/);
  });

  it("ships a healthcheck that reuses the /login probe", () => {
    expect(COMPOSE).toMatch(/healthcheck:/);
    expect(COMPOSE).toMatch(/test:.+wget.+\/login/);
  });

  it("uses init: true so PID 1 reaps zombie children", () => {
    expect(COMPOSE).toMatch(/init:\s*true/);
  });

  it("sets restart: unless-stopped (auto-recovery without infinite loops)", () => {
    expect(COMPOSE).toMatch(/restart:\s*unless-stopped/);
  });

  it("points BRIDGE_DB_PATH and BRIDGE_CONFIG_PATH at the /data mounts", () => {
    expect(COMPOSE).toMatch(/BRIDGE_DB_PATH:\s*\/data\/bridge\.db/);
    expect(COMPOSE).toMatch(/BRIDGE_CONFIG_PATH:\s*\/data\/config\.json/);
  });
});

describe("docker/.env.example — onboarding template", () => {
  it("lists DASHBOARD_PASSWORD with a placeholder, not a real secret", () => {
    expect(ENV_EXAMPLE).toMatch(/^DASHBOARD_PASSWORD=/m);
    expect(ENV_EXAMPLE).toMatch(/replace-with-/);
  });

  it("includes JWT_SECRET with a generation hint", () => {
    expect(ENV_EXAMPLE).toMatch(/^JWT_SECRET=/m);
    expect(ENV_EXAMPLE).toMatch(/openssl rand/);
  });

  it("documents Resend env vars (recommended, not required)", () => {
    expect(ENV_EXAMPLE).toMatch(/^RESEND_API_KEY=/m);
    expect(ENV_EXAMPLE).toMatch(/^RESEND_FROM_EMAIL=/m);
  });

  it("documents the optional host-mount overrides", () => {
    expect(ENV_EXAMPLE).toMatch(/^BRIDGE_HOST_CONFIG=/m);
    expect(ENV_EXAMPLE).toMatch(/^BRIDGE_HOST_DB=/m);
  });
});

describe("docker/Dockerfile.dockerignore — context filter", () => {
  it("excludes node_modules and the prior .next build", () => {
    expect(DOCKERIGNORE).toMatch(/^node_modules\b/m);
    expect(DOCKERIGNORE).toMatch(/^\.next\b/m);
  });

  it("excludes .env files (no secrets baked into layers)", () => {
    expect(DOCKERIGNORE).toMatch(/^\.env\b/m);
    expect(DOCKERIGNORE).toMatch(/^docker\/\.env\b/m);
  });

  it("excludes git metadata and dev artefacts", () => {
    expect(DOCKERIGNORE).toMatch(/^\.git\b/m);
    expect(DOCKERIGNORE).toMatch(/^tests\b/m);
  });
});
