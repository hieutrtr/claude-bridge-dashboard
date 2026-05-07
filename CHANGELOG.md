# Changelog

All notable changes to `@claude-bridge/dashboard` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The dashboard versions independently from the `claude-bridge` daemon
([compatibility matrix in the README](README.md#compatibility)).

---

## [v0.1.0] — 2026-05-07

First general-availability release. Phases 1–4 of the v1 / v2 implementation plan
shipped on `main` over four loop runs (Phase 1: 2026-05-05, Phase 2: 2026-05-06,
Phase 3: 2026-05-06, Phase 4: 2026-05-07). 51 task commits + per-task spec/review
files. Test suite: **1462 pass / 0 fail** (Bun) + 16 Playwright specs + Lighthouse
mobile ≥ 90 across 11 routes.

### Phase 1 — Read-only MVP (13 tasks)

- **Layout shell** — sidebar nav, route map, baseline Tailwind tokens.
- **Auth** — env-password owner login, JWT session cookie (HS256, 7d), middleware
  redirect to `/login` for unauthenticated requests.
- **Agents** — `agents.list` enrichment + grid page; `agents.get` + agent detail
  with Tasks tab.
- **Tasks** — global tasks list with filters; task detail page; JSONL transcript
  viewer (react-markdown + rehype-sanitize).
- **SSE** — `/api/stream/tasks` live updates for agent + task pages.
- **Cost analytics** — Recharts line + bar + breakdown by agent/day.
- **Memory** — read-only Auto Memory tab on the agent detail page.
- **Polish** — empty / error / loading states; dark / light theme polish (next-themes
  scaffold); Playwright smoke spec.

### Phase 2 — Actions (12 tasks)

- **Mutation invariant established.** Every mutation procedure travels through
  CSRF guard → rate-limit → audit-log write → MCP transport, with confirmation
  pattern for destructive surfaces. Phase 2/3/4 inherit this contract.
- **`tasks.dispatch`** via MCP from a ⌘K dialog; **`tasks.kill`** with
  `<DangerConfirm>`; **loop approve / reject** inline.
- **Audit log** — schema + writer + viewer page (`/audit`). Free-text PII never
  echoed (precedent extended in Phases 3 + 4).
- **Rate-limit** middleware (token bucket: 30/min/user mutations, 5/min/IP login).
- **CSRF** double-submit cookie pattern (`src/server/csrf-guard.ts`).
- **MCP connection pool** with health checks + warm reconnect.
- **Optimistic UI** with rollback (`runOptimistic`).
- **Permission relay UI** — SSE-driven toast for daemon-side approve/deny prompts.

### Phase 3 — Loops & schedules (9 tasks + sign-off)

- **Loops list / detail** with cost sparkline + per-iteration timeline.
- **Start loop dialog** with goal, done-condition picker, max-iterations slider, cost
  ceiling. CSRF + audit + MCP wired.
- **Cancel + approve** inline with `<DangerConfirm>` on cancel.
- **Schedules** — list, create form, cron picker (cronstrue + cron-parser), pause /
  resume / delete, run history drawer, **cost forecast** for the next N runs.
- **E2E Playwright** specs for the loop + schedule critical flows.

### Phase 4 — Polish & multi-user (13 tasks)

- **Magic-link auth** via Resend. New tables `users` + `magic_links` (single-use
  hashed tokens, 15-min TTL). Owner-env password login retained as fallback.
- **User management** page (`/users`) — invite via magic-link CTA, revoke (soft
  delete), promote/demote with self-protection guards.
- **RBAC** middleware (`role:owner` / `role:member`) with a 48-cell 403 matrix
  (`tests/server/rbac-matrix.test.ts`). Phase 1–3 routes retroactively gated.
- **Multi-user cost view** — `/cost` "By user" tab + leaderboard. Members see only
  their own row; owners see all.
- **⌘K command palette** — fuzzy search across agents, recent tasks, top actions,
  with role-aware command filtering and `?` help dialog.
- **Notification preferences** — in-app, email digest (Resend; hourly cron via
  `scripts/email-digest.ts`), browser-push stub (deferred to v0.2.0). Per-user
  prefs in `notification_preferences`.
- **Mobile responsive pass** — sidebar collapses to drawer < 768px; tables become
  card-lists < 640px. Lighthouse mobile ≥ 90 on every route.
- **Cloudflared tunnel** *(v2 delta)* — `bun run start:tunnel` spawns
  `cloudflared` alongside `next start`, prints public URL + QR. Refuses to start
  without strong password + Resend env.
- **Docker compose template** *(v2 delta)* — `docker/docker-compose.yml`,
  `docker/.env.example`, multi-stage Dockerfile. Mounts `config.json` read-only,
  `bridge.db` read-write. Non-root user, healthcheck.
- **Theme polish** — wired `next-themes` properly; AA contrast across all routes
  in both light + dark; axe-core `wcag2aa` zero violations.
- **Telemetry opt-in** — privacy-first. Default OFF, anonymous (`install_id` only,
  no `user_id`), PII scrubber on `event_name`, `record` is no-op when disabled,
  upload endpoint deferred to v0.2.0.
- **i18n scaffolding** — `en` + `vi` (Vietnamese) with 70 keys × 11 namespaces.
  `i18next` + `react-i18next`. Cookie-based persistence (no URL prefix).
- **Release docs + `v0.1.0` tag** *(v2 delta — this entry)* — README, CHANGELOG,
  RELEASE-NOTES, local annotated tag.

### Highlights

- **51 commits** on `main` (1 baseline + 50 feature/test/docs).
- **1462 unit + integration + component tests** pass under Bun.
- **16 Playwright specs** cover the critical flows: smoke, dispatch dialog, CSRF,
  rate-limit, audit view, loops, schedules, magic-link, user invite/revoke,
  RBAC 403, ⌘K palette, mobile viewport, dark-mode axe, i18n vi.
- **Lighthouse mobile ≥ 90** Performance / A11y / Best Practices / SEO across
  `/login`, `/`, `/agents`, `/tasks`, `/loops`, `/schedules`, `/cost`, `/audit`,
  `/users`, `/settings/notifications`, `/settings/telemetry`.

### Compatibility

- Bun ≥ 1.1
- `claude-bridge` daemon ≥ v1.0.0 (the `bridge.db` schema settled on the daemon's
  v0.5.x line is the read contract; the dashboard owns its own tables and migrates
  them via Drizzle).

### Out of scope (filed for v0.2.0)

- Onboarding wizard (originally v1 P4-T10 — slot taken by theme polish).
- Lighthouse-CI gate (perf-budget assertion in CI).
- Browser push notifications (full implementation; v0.1.0 ships permission stub).
- ICU plural rules + a third locale.
- Telemetry upload-loop (`TELEMETRY_ENDPOINT`).
- `bun run sync-schema` for daemon-side breaking changes.
- React-i18next removal (~6 kB shared-chunk savings).

[v0.1.0]: https://github.com/hieutrtr/claude-bridge-dashboard/releases/tag/v0.1.0
