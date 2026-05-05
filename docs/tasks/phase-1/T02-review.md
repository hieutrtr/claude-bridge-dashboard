# P1-T02 review — Auth: env-password middleware

> Self-review checklist for Rule 3 of the loop process.

## Files added

- `src/lib/auth.ts` — `SESSION_COOKIE`, `SESSION_TTL_SECONDS`, `signSession`,
  `verifySession`, `timingSafeEqual`, `readAuthEnv`. HS256 implementation
  via Web Crypto (no new deps; edge-runtime safe).
- `app/api/auth/login/route.ts` — `POST` handler: 200 on match,
  401 on mismatch, 400 on bad body, 503 if env not configured.
- `app/api/auth/logout/route.ts` — `POST` clears cookie, returns 200.
- `app/login/page.tsx` — server component shell using existing `Card`
  primitive; renders `<LoginForm>` if env configured, else hint.
- `app/login/login-form.tsx` — client component (`"use client"`) with
  password input + submit; handles 401/503/network with inline error
  message; honours `?next=<path>` redirect target after success.
- `middleware.ts` (project root) — Next.js middleware gating every route
  except `/login`, `/api/auth/login`, `/api/auth/logout` and Next
  internals.
- `tests/lib/auth.test.ts` — 16 tests, 30 expects (helpers).
- `tests/app/auth-login-route.test.ts` — 6 tests, 16 expects (login API).
- `tests/app/auth-logout-route.test.ts` — 1 test, 4 expects (logout API).

## Files modified

- `app/layout.tsx` — read session cookie via `next/headers` `cookies()`;
  if authed render the existing Sidebar+Topbar shell, else render bare
  children. No restructure of route directories — keeps T01 tests valid.
- `tests/app/route-stubs.test.ts` — add `/login` to `ROUTES` so the
  smoke check (file exists + default export is a function) covers it.

## Test results

```
$ bun test
 48 pass
 0 fail
 93 expect() calls
Ran 48 tests across 6 files.

$ bun run typecheck
$ tsc --noEmit         # exit 0
```

23 prior tests (Phase 0 + T01) + 25 new T02 tests (16 lib + 6 login route +
1 logout route + 2 route stub for `/login`) = 48 total.

## Self-review checklist

- [x] **Tests cover happy + edge case** — `signSession`/`verifySession`:
      happy round-trip, wrong-secret, tampered payload, malformed token
      (six bad shapes), expired token, empty-secret rejection.
      `timingSafeEqual`: equal, different-same-length, different-length,
      both-empty. `readAuthEnv`: full env, missing password, missing
      secret, empty strings treated as missing. Login route: success,
      wrong password, malformed body (two flavours), unset password env,
      unset secret env. Logout route: clears cookie, status 200.
- [x] **Not over-engineered** — no `jose` / `jsonwebtoken` dep; ~110 LOC
      of auth helpers using Web Crypto. Single-user single-secret. No
      DB row, no users table, no magic-link plumbing (those live in
      Phase 4 per v1 ARCH §6). Login UI uses existing `Card`/`Input`/
      `Button` primitives — no new shadcn components added.
- [x] **ARCHITECTURE v2 picks honoured** — Next.js App Router middleware
      (`middleware.ts` at root, edge runtime), shadcn primitives only,
      Tailwind v4 tokens (no inline colors apart from one error
      `text-red-500`). HS256 JWT cookie httpOnly + `SameSite=Lax` matches
      v1 §6 spec verbatim. `next-themes` already in place from T01 —
      `/login` inherits the dark default.
- [x] **No secret leak** — `DASHBOARD_PASSWORD` and `JWT_SECRET` are read
      via `readAuthEnv` only; never logged, never echoed in JSON
      responses, never sent to the client. The login form transports
      the user-supplied password over the same-origin POST as JSON
      (no query string, no localStorage). Cookie is `httpOnly` so JS
      cannot read the issued token. `secure: true` is set automatically
      in `NODE_ENV=production`.
- [x] **Read-only invariant** — no tRPC mutation procedure added; no
      `bridge_dispatch`, no DB write. The new POST endpoints
      (`/api/auth/login`, `/api/auth/logout`) only touch cookies +
      env — they do not write to `bridge.db`, the daemon socket, or
      any `tasks/loops/schedules` row. ✅
- [x] **Performance budget** — Web-Crypto JWT adds ~1 KB minified to the
      middleware bundle and ~0 KB to the client (`auth.ts` is server-
      only). Login page is a server component + one client form (~2 KB
      minified for the form's React hooks). First-load JS budget for
      `/agents` (the post-login landing) is unaffected. Will re-verify
      at the phase-end production build (loop step 15).

## Issues found

- **None blocking.**
- **Minor / observational:**
  - **Rate limiting not implemented.** v1 ARCH §10 calls for 5 req/min/IP
    on `/auth/*` plus a 15-minute cooldown after 5 consecutive fails.
    Out of scope for T02 (basic env-password only). **Decision: defer
    to T11** (empty/error/loading) or a dedicated Phase 2 hardening
    task; documented in `T02-auth-env-password.md` Notes.
  - **No CSRF Origin check** on the auth endpoints. v1 §10 specifies
    Origin checks on tRPC mutations; auth POST is single-form-origin
    and protected by `SameSite=Lax` already. **Decision: defer**;
    revisit when tRPC mutations land in Phase 2 along with Origin
    middleware.
  - **No `bridge_dashboard_install` integration** — env vars must be
    set by the operator until the v2 install MCP tool ships
    (Phase 5). Login page shows a clear "auth not configured" hint
    when env is missing so the failure mode is discoverable.
    **Decision: defer.**
  - **Auto-generated password** (v1 §6 says default-generate if env
    unset and print once) is intentionally NOT in T02. Generating a
    secret without a CLI to print it would silently lock the user
    out — fail-closed is safer until v2 install ships. **Decision:
    defer.**
  - **`secure` cookie flag** depends on `NODE_ENV === "production"`.
    For local dev (`bun run dev`) the cookie is sent over HTTP, which
    is correct. T13's Playwright spec will run against `bun run start`
    (production) so the secure flag will be exercised there.

## Verification trail

- `bun test` → 48 pass / 0 fail (logged above).
- `bun run typecheck` → clean exit.
- Browser/manual smoke deferred to loop step 16. Manual flow to verify
  later: set `DASHBOARD_PASSWORD=foo JWT_SECRET=bar bun run dev` →
  visit `/agents` → expect redirect to `/login?next=/agents` → wrong
  password shows "Wrong password." → correct password redirects to
  `/agents` and Sidebar/Topbar shell appears.

## Sign-off

T02 complete. Ready for T03 (`agents.list` enrichment + Agents grid) on
next iter. INDEX checkbox updated.
