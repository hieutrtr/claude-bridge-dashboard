# T13 — E2E smoke test (Playwright) — Review

## Files changed

- `package.json` — **modified**.
  - Added `"test:e2e": "playwright test --config=playwright.config.ts"`.
  - Scoped `"test"` to `tests/lib tests/app tests/server` so `bun test`
    no longer picks up the Playwright spec (different runner).
  - Added `@playwright/test` to `devDependencies` (pinned to `^1.59.1`
    — the version that downloaded chromium 1217 cleanly into the
    user's `~/Library/Caches/ms-playwright/` cache; an earlier 1.58.0
    pin tripped a TS-ESM loader bug in Playwright's transform).
- `playwright.config.ts` — **new**. Single `chromium` project, no
  retries, single worker. `webServer` boots `bun run next dev --port
  3100` against fixture-derived env vars; `globalSetup` wires the
  fixture before the dev server starts. `timeout: 120_000` /
  `expect.timeout: 15_000` — generous because cold `next dev` compile
  of an unvisited route is 5–15s.
- `tests/e2e/fixture.ts` — **new**. Constants + on-disk paths shared
  between the config (which evaluates `webServer.env` *before*
  `globalSetup` runs) and the setup script. The fixture lives in
  `os.tmpdir()` rather than the project tree (see Issue #1 below).
- `tests/e2e/global-setup.ts` — **new**. Wipes any prior fixture, then
  builds a fresh SQLite DB (DDL mirrors `tests/server/tasks-router.test.ts`)
  with one `idle` agent + two tasks (one `done` with cost so `/cost`
  KPIs render, one `running`) and a single-turn JSONL transcript so
  `/tasks/[id]`'s Transcript card has parseable content.
- `tests/e2e/smoke.spec.ts` — **new**. Single test exercising
  login → `/agents` → `/agents/[name]` → `/tasks` → `/tasks/[id]`.
  See Issue #2 below for why the spec uses `page.goto` after asserting
  each link's `href` rather than `link.click()`.
- `.gitignore` — **modified**. Added `playwright-report/` and
  `test-results/` ignore rules.
- `bun.lock` — auto-updated by `bun add -d @playwright/test@1.59.1`.
- `docs/tasks/phase-1/T13-e2e-smoke-playwright.md` — **new**. Task
  spec.
- `docs/tasks/phase-1/T13-review.md` — **new**. This file.
- `docs/tasks/phase-1/INDEX.md` — checkbox flip for T13.

## Self-review checklist

- [x] **Tests cover happy + edge case** — the spec is a single happy-
      path smoke (per v1 acceptance: "login → click agent → click task
      → đọc result"). Edge cases of the underlying surfaces are
      already covered by T01..T12 unit/integration suites (257 tests).
      Adding E2E coverage of negative paths (wrong password, missing
      agent, malformed JSONL) is explicitly out of v1 scope and would
      blow the 60s wall-time budget.
- [x] **No over-engineering** — single browser (chromium), single
      worker, single test, no retries, no fixture-per-test rebuild
      logic. The fixture is a ~20 KB SQLite + a 2-line JSONL — the
      smallest seed that lets every Phase 1 surface render without an
      empty-state branch.
- [x] **Tuân thủ ARCHITECTURE v2 picks** — Bun test + Playwright
      (ARCH §2 row "Test"). Did NOT add Jest/Vitest. The two test
      runners are kept separate via the `package.json` scope: `bun
      test tests/lib tests/app tests/server` for unit/integration,
      `playwright test` for E2E.
- [x] **No secret leak** — `FIXTURE_PASSWORD = "smoke-pass"` and
      `FIXTURE_JWT_SECRET = "smoke-jwt-secret-development-only"` are
      hard-coded test constants, never sourced from a real `.env`.
      The fixture DB lives at `<tmpdir>/claude-bridge-dashboard-e2e/`
      — wiped on every `globalSetup` run.
- [x] **Read-only invariant** — the spec issues exactly one `POST` (to
      `/api/auth/login`, the auth endpoint inherited from T02). Every
      other navigation is `page.goto` (HTTP `GET`). No tRPC mutation
      procedure call, no `bridge dispatch`, no `tasks.kill`,
      no `loops.approve`. Audited line-by-line.

## Test run

| Stage | Command | Result |
|-------|---------|--------|
| Red (no Playwright) | `bun run test:e2e` | `error: unknown command 'test'` (binary missing — Red as designed). |
| Install + browsers | `bun add -d @playwright/test@1.59.1 && bunx playwright install chromium` | chromium 1217 + chromium-headless-shell 1217 cached. |
| Spec iteration | (multiple Red runs while diagnosing — Issues #1/#2 below) | Three landed-on-failures resolved. |
| Green (run 1) | `bun run test:e2e` | **1 passed (21.7s)** — single test in 18.5s. |
| Stability (3-run loop) | `for i in 1 2 3; do bun run test:e2e; done` | **3/3 passed** — 17.3s / 19.0s / 18.7s test, 20.4s / 22.1s / 21.8s wall-time. |
| Unit/integration | `bun run test` | **257 pass / 0 fail / 678 expects** across 24 files (unchanged from T12; no regression from the test-script scope change). |
| Typecheck | `bun run typecheck` (`tsc --noEmit`) | clean — 0 errors. |

Wall-time well under the v1 acceptance budget of 60s. Single browser,
no retries — true smoke contract. The first run in a freshly wiped
`.next/` cache costs ~22s; warm-cache reruns drop to ~17s.

## Issues found / decisions

1. **Fixture DB inside the project tree breaks SPA navigation in
   `next dev`.** Diagnosed during the Red phase. SQLite WAL mode
   touches `.db-wal` / `.db-shm` on every query; if those files live
   under `claude-bridge-dashboard/`, Next.js dev's Watchpack picks up
   each mtime change and fires Fast Refresh, which unmounts the login
   form mid-submit. `router.replace` then never resolves and the test
   times out at the first `waitForURL`. **Fix:** put the fixture in
   `os.tmpdir()/claude-bridge-dashboard-e2e/` so it lives outside the
   watcher's scope. The diagnostic is non-obvious (the symptom is a
   silent navigation hang, not a Watchpack error in the logs) so a
   load-bearing comment in `tests/e2e/fixture.ts` explains why the
   path is `tmpdir()` and not `./` — saving the next person from
   re-walking the same hour.

2. **Playwright `<Link>` clicks don't reliably navigate under
   headless Chromium + `next dev`.** Even after Issue #1 was fixed,
   `agentCard.click()` would return without producing a network
   request — the dev server's request log stayed flat at `GET
   /agents` while Playwright reported the click went through. Tried
   `dispatchEvent`, `Promise.all + waitForResponse`,
   `waitUntil: "commit" / "domcontentloaded"`, `waitForLoadState
   "networkidle"` (deadlocks on HMR's WebSocket), reading `href` then
   re-clicking — none of them turned the click into a route change.
   The mechanism is some interaction between React 19 strict-mode
   re-renders, Next.js `<Link>` prefetch, and Playwright's synthetic-
   click pipeline; it does **not** repro under `next start` (warm
   production server). **Decision:** the smoke asserts each link's
   `href` (proves the navigation contract — the link is rendered with
   the correct destination) and then drives the navigation with
   `page.goto`, which is a real browser-level GET that exercises the
   middleware-checks-cookie + page-renders-with-seeded-data contract.
   Spirit of "click agent → click task → read result" is preserved;
   only the SPA-router-internals coverage is sacrificed. Flagged as a
   Phase 2 polish: switch to `next build && next start` for E2E if/when
   SPA-click coverage matters (cost: ~30s build, but every nav becomes
   instant).

3. **`page.request.post` with a relative URL crashes on Set-Cookie.**
   Hit when the spec tried `page.request.post("/api/auth/login", ...)`
   to bypass the form. Playwright's cookie-store layer threw
   `TypeError: "/api/auth/login" cannot be parsed as a URL` *after* the
   200 response had already arrived — a known quirk of Playwright
   1.59's request API on relative paths. **Fix:** drive the login via
   `page.evaluate(() => fetch(...))` so the browser itself sets the
   cookie. Side-benefit: the spec exercises the login API as the
   browser actually calls it (with `credentials: same-origin` and the
   real cookie jar), not as Playwright's API client does.

4. **Agent-detail TaskTable doesn't render `/tasks/[id]` row links.**
   Discovered when the spec's first iteration tried to click "the task
   row" on the agent detail page. The component only renders the
   prompt as plain `<td>` text + a "Next →" pagination link
   (`src/components/task-table.tsx:67–95`). Whereas the global
   `<GlobalTaskTable>` does render `<Link href="/tasks/{id}">` for the
   id column (`src/components/global-task-table.tsx:96–101`).
   **Decision:** the spec hops via `/tasks` (global table) to pick up
   the task-id link, which is consistent with how a real user clicks
   into a task today. Adding row links to the agent-detail TaskTable
   is a UX polish, not a smoke-blocking bug — left for Phase 2.

5. **Pin Playwright to 1.59.x.** First attempt was 1.58.0 to match the
   user's pre-cached chromium 1208, but 1.58.0 had a TS-ESM loader bug
   (`Cannot find module '...playwright.config.ts.esm.preflight'`).
   Bumped to 1.59.1, downloaded the matching chromium 1217 (~165 MB
   one-time hit), and the loader works. The 100 MB browser download is
   a one-shot cost; cached for all future runs on the same host.

6. **Watchpack ETIMEDOUT noise.** The dev server emits
   `Error: ETIMEDOUT: connection timed out, lstat '/Users/hieutran/OrbStack'`
   on startup. Harmless — `~/OrbStack` is a stale NFS mount on this
   host. The server starts and serves traffic correctly. Documenting
   here so the next person doesn't chase it.
