# P1-T13 — E2E smoke test (Playwright)

> Phase 1, Task 13 of 13. Read-only invariant — the spec exercises only
> `GET` flows (login → agents → agent → task → result). No mutation,
> no `bridge dispatch`, no `tasks.kill`.

## Source

- v1 plan task: `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/IMPLEMENTATION-PLAN.md` line 99 ("P1-T13 — E2E smoke test").
- v2 plan: re-points to v1 P1-T13 (no override).

## Architecture refs to read first

- `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/ARCHITECTURE.md`
  - §2 row "Test" — Bun test cho unit/tRPC + **Playwright cho E2E happy path**;
    no Jest/Vitest.
  - §11 Performance Budgets — TTI < 1.0s on M1 Chrome local; the spec's
    timeouts must respect this so a regression surfaces as a slow-test
    failure, not a timeout flake.

## Spec (paraphrased from plan)

> Playwright: login → click agent → click task → đọc result.
> Acceptance: chạy CI < 60s, không flaky.
> Deps: tất cả Phase 1.

## Acceptance criteria

1. A Playwright spec lives at `tests/e2e/smoke.spec.ts` and exercises the
   end-to-end happy path: visit `/agents` → redirected to `/login` →
   submit password → see seeded agent's name on `/agents` → click into
   `/agents/[name]` → click into `/tasks/[id]` → assert the seeded result
   markdown is rendered.
2. The Playwright config (`playwright.config.ts`) auto-starts a real
   Next.js dev server (`bun run dev -- --port 3100`) wired to a fixture
   SQLite DB + a fixture `CLAUDE_HOME` populated by a one-shot global
   setup. The dev server reuses the cached `.next/` between local runs;
   the fixture DB is recreated each run for determinism.
3. The spec **does not** depend on the user's real `~/.claude-bridge/bridge.db`
   or `~/.claude/`. `BRIDGE_DB`, `CLAUDE_HOME`, `DASHBOARD_PASSWORD`,
   `JWT_SECRET` are all set by the config — running with those unset must
   still succeed.
4. Total wall time on a warm dev cache: well under 60s for `chromium`
   only (the v1 acceptance bullet). The spec is single-file, single-test,
   single-browser; no parallel projects, no retries (retries hide flake).
5. The new test command `bun run test:e2e` runs the spec; the existing
   `bun test` script keeps running unit/integration only. `bun test`
   must not pick up `tests/e2e/**` (different runner; would crash on the
   Playwright `test` import).
6. **Read-only invariant** holds: the spec navigates (`page.goto`),
   clicks (`page.click`), reads text (`expect(...).toBeVisible()`); it
   never POSTs to a mutation procedure or calls `bridge dispatch` /
   `bridge_create_agent` / etc. The login form is the only `POST`, and
   that's auth — already inherited from T02.

## Test plan (TDD — Playwright)

The "TDD red" step is non-trivial because adding `@playwright/test` is
itself part of the implementation. We red-light by writing the spec
first (it can't run yet — package missing) and confirming the runner
errors with a missing-module error; then we install + configure to turn
green.

### `tests/e2e/smoke.spec.ts` (NEW)

A single `test("phase-1 smoke: login → agent → task → result")` that:

- `await page.goto("/agents")` — middleware redirects to `/login?next=/agents`.
- Fills the password input with the value the global setup wrote into
  `DASHBOARD_PASSWORD`, clicks `Sign in`.
- After redirect, asserts the agent name (`smoke-agent`) is visible on
  the agents grid.
- Clicks the agent card link → URL becomes `/agents/smoke-agent`.
- Asserts the task row (`Investigate flaky test`) is visible in the
  Tasks tab table; clicks the row's task link → URL becomes `/tasks/<id>`.
- Asserts the page heading shows `#<id>` and the seeded result markdown
  paragraph (`E2E smoke result`) is visible inside the Result card.

### `tests/e2e/global-setup.ts` (NEW)

- Creates `tests/e2e/.fixture/bridge.db` from scratch (DDL: `agents`,
  `tasks`, plus the empty support tables the routers don't touch — only
  what tRPC procedures actually `select` from).
- Seeds 1 agent + 2 tasks (one `done` with a non-null `cost_usd` so the
  Cost page's empty-state doesn't trigger; one `running`).
- Writes `tests/e2e/.fixture/.claude/projects/<slug>/<session>.jsonl`
  with one assistant turn so the transcript card doesn't crash and the
  page renders the result section.
- Returns nothing — Playwright re-reads the env vars from the config.

### `playwright.config.ts` (NEW)

- `testDir: "./tests/e2e"`
- `globalSetup: "./tests/e2e/global-setup.ts"`
- `webServer.command: "bun run dev -- --port 3100"`
- `webServer.url: "http://localhost:3100/login"` (200 on first paint —
  middleware does not redirect /login itself)
- `webServer.timeout: 60_000`
- `webServer.env`: `BRIDGE_DB`, `CLAUDE_HOME`, `DASHBOARD_PASSWORD`,
  `JWT_SECRET`, `NODE_ENV=development` (auth cookie sets `secure:false`
  in dev — required so the cookie sticks under http://localhost).
- `use.baseURL: "http://localhost:3100"`
- `projects: [{ name: "chromium", use: devices["Desktop Chrome"] }]`
- `retries: 0` (spec must not be flaky; do not paper over with retries)
- `reporter: process.env.CI ? "github" : "list"`

### Bun test isolation

Update `package.json`:

- `test`: `bun test tests/lib tests/app tests/server` — explicit dirs,
  excludes `tests/e2e/**`.
- `test:e2e`: `playwright test --config=playwright.config.ts`.
- Add `@playwright/test` to `devDependencies`.

## Files to create / modify

- NEW `tests/e2e/smoke.spec.ts` — single happy-path E2E.
- NEW `tests/e2e/global-setup.ts` — DDL + seed.
- NEW `playwright.config.ts` — webServer + project + globalSetup.
- NEW `.gitignore` lines for `tests/e2e/.fixture/`, `playwright-report/`,
  `test-results/` (if the repo has a `.gitignore`; else skipped).
- MODIFY `package.json` — `test` scope + new `test:e2e` script + new dev
  dep `@playwright/test`.

## Notes / open questions

- **Playwright browsers cache.** `~/Library/Caches/ms-playwright/` already
  has chromium 1208 installed (verified pre-task); no new download
  required for the local run. Fresh CI machines would need
  `playwright install chromium` first — flagged in the review doc, not
  added to the test script (avoids a 100 MB download per `test:e2e`
  invocation). If a future CI lane wants this auto-handled, gate it on
  an env var.
- **`next dev` vs `next build && next start`.** The spec uses dev so the
  first run after `bun install` doesn't pay the full build cost. Trade-off:
  the *very first* page nav inside the spec compiles the route on demand,
  taking 2–5s; warm runs are < 200ms. With `expect.timeout` at the
  Playwright default (5s) plus a 20s `waitForURL`, the smoke covers
  cold-cache too. If flake shows up in practice, switch to
  `next build && next start` (extra ~30s build, but every nav is fast).
- **Fixture DB lives under `tests/e2e/.fixture/`** so it's easy to wipe
  and so the path is obvious. Not under `node_modules` (would get cleaned
  by `bun install --force`) and not under `.next/` (Next would treat it
  as an asset).
- **Single test, no fixtures.** Splitting into multiple specs (one per
  page) would just be wall-time bloat; v1 acceptance asks for a smoke,
  not coverage. Page-level coverage is already in the unit/integration
  layer (T01..T12 tests). Future Phase 2+ E2E (mutation flows) should
  add new specs — not extend this one.
- **Mutation invariant proof.** The spec uses only `page.goto`,
  `page.fill`, `page.click`, `expect(...).toBeVisible()` — no
  `page.request.post(...)` to any mutation route. The single POST is the
  login submit, which goes through `app/api/auth/login/route.ts` (T02).
  The review doc audits this explicitly.
