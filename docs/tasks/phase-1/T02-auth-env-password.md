# P1-T02 — Auth: env-password middleware

> Phase 1, Task 2 of 13. Read-only invariant — auth gates the existing
> read-only surface; no mutation procedure is added or invoked.

## Source

- v1 plan task: `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/IMPLEMENTATION-PLAN.md` line 66 ("P1-T2 — Auth: env-password middleware").
- v2 plan: re-points to v1 P1-T2 (path-rewrite only; no override). v2 plan
  line 71 confirms: "P1-T2 auth … giữ nguyên acceptance, đổi cwd".

## Architecture refs to read first

- `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v1/ARCHITECTURE.md`
  - §6 (Auth — Magic Link + Password Env) — single-user default = env
    password; cookie httpOnly + JWT HS256. **Magic-link path is Phase 4**;
    do NOT implement here.
  - §10 (Security) — CSRF (`SameSite=Lax`), brute-force note (rate-limit is
    NOT in T02 scope; flagged in Notes), secret leakage (`JWT_SECRET` from
    env only, never logged).
- v2 ARCH §0 confirms §6 is inherited unchanged.

## Spec (paraphrased from plan)

> `DASHBOARD_PASSWORD` env, login form, JWT cookie httpOnly 7d.
> Acceptance: chưa login → redirect `/login`; sai password → 401; đúng → set
> cookie.

## Acceptance criteria

1. `DASHBOARD_PASSWORD` env var holds the single-user password (no DB row,
   no hash file). Reading it lives in one helper (`readAuthEnv`).
2. `JWT_SECRET` env var holds the HMAC key for session token signing. If
   missing, `signSession` / `verifySession` MUST refuse (no silent fallback
   to a static dev key — fail closed).
3. `POST /api/auth/login` accepts `{ password: string }`. Response:
   - `200` + `Set-Cookie: bridge_dashboard_session=<jwt>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` on match.
   - `401 invalid_password` on mismatch.
   - `503 auth_not_configured` if `DASHBOARD_PASSWORD` is unset.
   - `400 invalid_body` if payload missing/wrong shape.
4. `POST /api/auth/logout` clears the cookie (sets `Max-Age=0`) and returns
   `200`.
5. Next.js middleware (`middleware.ts`) gates every route EXCEPT:
   - `/login` (the form itself).
   - `/api/auth/login`, `/api/auth/logout` (the auth endpoints).
   - Next.js internals (`/_next/*`, `/favicon.ico`).
   Unauthenticated requests to any other path → `307` redirect to `/login`.
6. `/login` page renders a single password input + submit. On success, the
   browser is sent back to `/agents` (or to a `?next=` redirect target if
   the middleware appended one — optional, see Notes).
7. The JWT carries `{ sub: "owner", iat, exp }` with `exp = iat + 7 days`.
   Verify rejects: bad signature, malformed token, missing parts, expired.
8. Session token comparison uses constant-time equality (`timingSafeEqual`).
9. **Read-only invariant:** no mutation tRPC procedure is added; the auth
   routes are POSTs but do not touch `bridge.db` or call `bridge_dispatch`.

## Test plan (TDD — Bun test)

The auth helpers are pure, self-contained, and unit-testable. Middleware +
route handlers integrate Next.js runtime, so we cover their *logic* via the
helpers and defer end-to-end browser assertions to T13 (Playwright).

### `tests/lib/auth.test.ts` (NEW)

`signSession` / `verifySession`:
- happy path — round-trips and yields `{ sub: "owner", iat, exp }` with
  `exp - iat === 604800`.
- token format — three base64url segments separated by `.`.
- wrong-secret rejection — token signed with secret A, verified with secret
  B → `null`.
- tampered payload rejection — flip one byte of the payload segment → `null`.
- malformed token rejection — `""`, `"abc"`, `"a.b"`, `"a.b.c.d"` → `null`.
- expiry — token with `exp < now` returns `null`.

`timingSafeEqual`:
- equal strings → `true`.
- different strings same length → `false`.
- different lengths → `false` (without short-circuiting; we just need
  correctness — exhaustive timing analysis is overkill for env-password).

`readAuthEnv`:
- both env present → returns `{ password, secret }` with values.
- `DASHBOARD_PASSWORD` missing → `password === null`, `secret` still echoed.
- `JWT_SECRET` missing → `secret === null`.
- Accepts an optional `env` arg (defaults to `process.env`) so tests
  inject without mutating real `process.env`.

### `tests/app/auth-login-route.test.ts` (NEW)

Exercise `POST /api/auth/login` by directly invoking the route handler
(import the `POST` export). Use `new Request(...)` to drive it. Assert
status + the `Set-Cookie` header includes the expected attributes.

- happy path → `200`, `Set-Cookie` contains `bridge_dashboard_session=`,
  `HttpOnly`, `SameSite=lax` (Next normalises case), `Path=/`,
  `Max-Age=604800`.
- wrong password → `401`, no `Set-Cookie`.
- malformed body → `400`.
- env missing → `503`.

### `tests/app/auth-logout-route.test.ts` (NEW)

- `POST /api/auth/logout` → `200`, `Set-Cookie` clears the session cookie
  (`Max-Age=0` or `Expires=Thu, 01 Jan 1970…`).

### `tests/app/route-stubs.test.ts` (UPDATE — additive)

Add an entry for `/login` so the existing convention (page exists +
default export is a function) still applies. Pre-existing 5 routes stay
unchanged.

## Files to create / modify

- NEW `src/lib/auth.ts` — `SESSION_COOKIE`, `SESSION_TTL_SECONDS`,
  `signSession`, `verifySession`, `timingSafeEqual`, `readAuthEnv`.
  All-Web-Crypto (HMAC-SHA256), edge-runtime safe.
- NEW `app/login/page.tsx` — server component shell.
- NEW `app/login/login-form.tsx` — client component (`"use client"`) with
  `<form>` POSTing JSON to `/api/auth/login`, handling 401/503/network
  errors with inline message.
- NEW `app/api/auth/login/route.ts` — POST handler.
- NEW `app/api/auth/logout/route.ts` — POST handler.
- NEW `middleware.ts` (project root) — Next.js middleware gating routes.
- MODIFIED `app/layout.tsx` — read session cookie via `next/headers`
  `cookies()`; if authed render the existing Sidebar+Topbar shell, else
  render bare children (so `/login` is not wrapped in the dashboard
  chrome). No restructure of route directories — keeps T01 tests valid.
- MODIFIED `tests/app/route-stubs.test.ts` — add `/login` to ROUTES.
- NEW `tests/lib/auth.test.ts`, `tests/app/auth-login-route.test.ts`,
  `tests/app/auth-logout-route.test.ts`.

## Notes / open questions

- **Magic link** — explicitly NOT in T02 (v1 §6 says Phase 4). Decision:
  defer.
- **Auto-generate password if env missing** — v1 §6 mentions
  `bridge dashboard --start` printing a one-shot generated password. The
  dashboard repo has no CLI entry (v2 distributes via MCP); we therefore
  fail closed when env is unset, with a helpful login-page hint. Decision:
  fail-closed; revisit when `bridge_dashboard_install` (v2 P5-T2) lands.
- **Rate limiting** — v1 §10 calls for 5 req/min/IP on `/auth/*` and a
  15-min cooldown after 5 fails. Out of scope for T02 (basic auth only);
  flag for **T11** (error / loading states) or a dedicated Phase 2 task.
  Decision: defer.
- **Magic-link token table** — `web_sessions` table not used in env-only
  flow. Decision: defer until Phase 4.
- **`?next=` redirect target** — middleware can append `?next=<encoded>` so
  the user lands back where they tried to go after login. Optional
  ergonomic; if implemented, the login form should `router.replace(next)`
  on success. Decision: implement as optional, default `/agents`.
- **HS256 vs Ed25519** — HS256 (HMAC) is single-user single-secret and the
  simplest verifier; Ed25519 buys nothing here. Decision: HS256.
- **No `jose` / `jsonwebtoken` dep** — we use Web Crypto directly. Keeps
  the bundle lean (perf budget §11) and stays edge-runtime-compatible.
  Trade-off: more code to maintain (~80 LOC); upside: zero supply-chain
  surface. Revisit if we add OIDC in Phase 4.
- **Route-group restructure** — considered moving authed pages under
  `app/(app)/` so a subgroup layout owns the shell, but that churns T01
  files and tests. Conditional render in root layout achieves the same
  user-visible result with less diff. Decision: conditional render.
