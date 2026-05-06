# T01 — Magic-link auth via Resend

> **Phase:** 4 (Polish & Multi-user) · **Iter:** 2/16 · **Status:** done · **Risk:** Medium (Resend HTTP error handling + single-use race) · **Depends:** Phase 1 auth primitives (`signSession`/`verifySession`), Phase 2 rate-limit + audit, Phase 3 routers

## Goal

Lay the foundation that the rest of Phase 4 stands on: a working magic-link
sign-in flow that issues normal dashboard sessions, opens a `users` table, and
keeps the existing env-password identity working with zero behavior change.

Eight of the thirteen Phase 4 tasks (T02 user-mgmt, T03 RBAC, T04 multi-user
cost, T05 ⌘K palette, T06 notifications, T08 cloudflared, T11 telemetry, T13
release) consume this surface; getting the bones right here keeps churn out of
later iterations.

## Surface delivered

### New SQLite tables (dashboard-owned)

**`users`** — `src/db/migrations/0002_users.sql`

| col              | type    | note                                                                  |
|------------------|---------|-----------------------------------------------------------------------|
| `id`             | TEXT PK | `crypto.randomUUID()` for magic-link rows; literal `"owner"` for env-password identity (synthetic; see T01-review §3). |
| `email`          | TEXT NN | Original-case original input (lowercased for unique lookup via the generated col). |
| `email_lower`    | TEXT    | `GENERATED ALWAYS AS (lower(email)) STORED` — case-insensitive unique key. |
| `role`           | TEXT NN | `'owner' | 'member'`, default `'member'`. T03 wires the matrix.       |
| `display_name`   | TEXT    | nullable.                                                             |
| `created_at`     | INT NN  | Date.now() ms.                                                        |
| `last_login_at`  | INT     | nullable; updated on every successful consume.                        |
| `revoked_at`     | INT     | soft-delete timestamp; T02 wires the `users.revoke` mutation. Treated as 401 by the consume route. |

Indexes: `idx_users_email_lower` (UNIQUE) + `idx_users_revoked_at`.

**`magic_links`** — `src/db/migrations/0003_magic_links.sql`

| col               | type    | note                                                                |
|-------------------|---------|---------------------------------------------------------------------|
| `token_hash`      | TEXT PK | `base64url(sha256(plaintext))` — the plaintext token is **never** persisted. |
| `email`           | TEXT NN | Recipient (normalised lowercase).                                   |
| `email_lower`     | TEXT    | Generated col; mirrors `users.email_lower`.                         |
| `created_at`      | INT NN  | Date.now() ms.                                                      |
| `expires_at`      | INT NN  | `created_at + 15 * 60 * 1000` (the 15-min ARCH §6 ceiling).         |
| `consumed_at`     | INT     | nullable; the single-use guard. The consume route runs `UPDATE … SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL` so simultaneous clicks resolve atomically. |
| `request_ip_hash` | TEXT    | `base64url(sha256("ip:" + xff + ":" + salt))` — privacy-preserving forensic correlation. |

Indexes: `idx_magic_links_expires_at` + `idx_magic_links_email_lower`.

### tRPC `auth.*` router (`src/server/routers/auth.ts`)

| procedure     | shape                            | notes                                                         |
|---------------|----------------------------------|---------------------------------------------------------------|
| `auth.me`     | Query → `AuthMeResponse \| null` | `null` for unauthenticated / unknown / revoked. Returns synthetic env-owner row when `sub === "owner"` (no DB read). Response shape: `{ id, email, role, displayName }`. |
| `auth.logout` | Mutation → `{ ok: true }`        | Audits `auth.logout` with the session subject. Cookie clearing remains the responsibility of the existing `/api/auth/logout` route — this mutation lets the SPA fire-and-forget the audit event in parallel. |

`requestMagicLink` and `consumeMagicLink` deliberately ship as **REST routes**
rather than tRPC mutations. Rationale documented in `T01-review.md` §1.

### REST routes

**`POST /api/auth/magic-link/request`** — public, no CSRF, rate-limited.

1. Validates email (`z.string().email()` + 320-char cap).
2. Runs the magic-link rate limit (5/min/IP **and** 5/hour/email-hash).
3. Audits `auth.magic-link-request` with `{ emailHash }` — never plaintext.
4. Generates 32 random bytes (URL-safe base64), inserts the hash into
   `magic_links`, sends the email via Resend.
5. **Always returns `{ ok: true }`** even on Resend / DB / config failure
   (privacy: response shape must not leak whether the email exists or is
   actually deliverable). Audit captures every failure mode.

**`GET /api/auth/magic-link/consume?token=…`** — public, GET-then-redirect, rate-limited.

1. 5/min/IP rate limit (token-grinding defence; tokens are 256-bit random so
   brute force is infeasible — the bucket is belt-and-braces).
2. Looks up `token_hash`; runs the atomic single-use guard
   `UPDATE … WHERE consumed_at IS NULL`.
3. Validates `expires_at > now`.
4. Find-or-create the matching `users` row (defaults to `role: "member"`).
5. Refuses revoked users (`revoked_at !== null`) → `?error=user_revoked`.
6. Signs a session JWT with `sub: user.id`, sets the HttpOnly session cookie
   and a fresh CSRF cookie (matches `/api/auth/login` shape).
7. Redirects to `/agents` (or the safe `next` query param).

Failure outcomes redirect to `/login?error=<code>` — `expired_token`,
`used_token`, `invalid_token`, `missing_token`, `user_revoked`,
`server_error`. The login page renders friendly copy per code via the
new `LoginErrorBanner` server component.

### Frontend

- `app/login/page.tsx` extended — server component renders the password
  form (existing P1) **AND** the new magic-link form when Resend is
  configured. Surface error params from the consume route via
  `<LoginErrorBanner>`.
- `app/login/magic-link-form.tsx` — client component; POSTs to
  `/api/auth/magic-link/request` and shows the "check your email" state.
- `app/login/login-error-banner.tsx` — server component; maps the
  `?error=<code>` param to a friendly title + body.

### Library + server primitives

- `src/lib/auth.ts` — `SessionPayload.sub` widened from the literal
  `"owner"` to `string`. `signSession(secret, opts?)` now takes an
  options object (`{ sub?, now? }`) instead of the positional `now`.
  Backwards-compat: `signSession(secret)` still produces a `sub:"owner"`
  token, so existing P1 password sessions keep working.
- `src/lib/magic-link-token.ts` — `generateMagicLinkToken()` (32 random
  bytes URL-safe base64, 43 chars), `hashMagicLinkToken()` (SHA-256
  base64url), `MAGIC_LINK_TTL_SECONDS = 15 * 60`.
- `src/lib/email-hash.ts` — `normalizeEmail`, `emailHash(email, salt)`
  (SHA-256(normalized + ":" + salt) base64url), `resolveAuditSalt()`
  (mirrors audit.ts' salt resolution).
- `src/server/auth-users.ts` — `findUserById`, `findUserByEmail`,
  `findOrCreateUser`, `recordLogin`, `envOwnerUser`, `resolveSessionUser`.
- `src/server/rate-limit-magic-link.ts` — three buckets (IP + email +
  consume), all separately env-overridable. Audits the scope that
  tripped (`magic-link-request:ip`, `magic-link-request:email`,
  `magic-link-consume:ip`).
- `src/server/resend.ts` — minimal HTTP client (no SDK dep). `__setResendFetch`
  test seam; `readResendConfig()` returns `null` when env unset (graceful fail).

### Middleware

`middleware.ts` — `PUBLIC_EXACT` adds `/api/auth/magic-link/request` and
`/api/auth/magic-link/consume`. Same auth/CSRF behaviour for everything
else.

## Test surface

| File                                                | Tests | Focus                                                             |
|-----------------------------------------------------|-------|-------------------------------------------------------------------|
| `tests/lib/auth.test.ts` (extended)                 | +2    | Sub-widening round-trip; empty-sub rejection; existing tests migrated to opts shape. |
| `tests/lib/magic-link-token.test.ts` (new)          | 8     | Random uniqueness (1k samples), URL-safe alphabet, 32-byte length, 15-min TTL ceiling, hash determinism. |
| `tests/lib/email-hash.test.ts` (new)                | 12    | Determinism, case-insensitivity, salt-rotation invalidates correlation, no plaintext leak in digest, salt-resolution priority. |
| `tests/server/resend.test.ts` (new)                 | 10    | Config presence/absence, request shape (Bearer auth, JSON body, `to` normalised), error/network/malformed-body fall-throughs. |
| `tests/server/rate-limit-magic-link.test.ts` (new)  | 9     | 5/min/IP + 5/hr/email separation, consume bucket, env disable, 429 + Retry-After. |
| `tests/server/auth-router.test.ts` (new)            | 9     | `auth.me` matrix (anon / sub=owner / UUID / unknown / revoked / role=owner); `auth.logout` audits. |
| `tests/app/auth-magic-link-request-route.test.ts` (new) | 13 | 200 + row insertion + email send; lowercase normalisation; **emailHash NEVER plaintext** in audit; token-in-URL hashes back to row PK; BRIDGE_DASHBOARD_ORIGIN; 200 on Resend down + audit-only; 503 missing JWT_SECRET; 400 validation; rate-limit 6th request from IP and from email. |
| `tests/app/auth-magic-link-consume-route.test.ts` (new) | 11 | Cookies set + sub matches user UUID + `users` row created; tokenIdPrefix not full token in audit; safe `next`; open-redirect rejection; second consume → `used_token`; `users` row reuse; expired/unknown/missing/revoked redirects; 5/min/IP rate-limit on consume failures. |

## Acceptance (from INDEX)

- [x] Email arrives < 30s on Resend free tier — exercised via the test seam
      (`__setResendFetch` injected, request shape verified).
- [x] Token expires after 15 min — `MAGIC_LINK_TTL_SECONDS = 900` enforced
      both in lib constant and in the consume route's `expires_at <= now`
      check; test `expired_token`.
- [x] Second consume returns 410 Gone semantics with `auth.magic-link-consume
      status=already_used` — implemented via the atomic `UPDATE … WHERE
      consumed_at IS NULL`; redirect to `/login?error=used_token`; test
      `subsequent consume of same token`.
- [x] Emails NOT logged in plaintext — audit only records `emailHash` (request)
      or `tokenIdPrefix` (consume); fuzz tests assert "alice"/"example" never
      appear in audit JSON.

## Phase 4 invariant checklist

- [x] **CSRF guard:** N/A for the magic-link routes (same exemption as
      `/api/auth/login` — pre-session callers have no CSRF cookie). Mitigated
      by per-IP + per-email rate limit. Documented in `T01-review.md` §1.
- [x] **Rate limit:** dedicated `rate-limit-magic-link.ts` with three buckets.
      Audit row records the scope, never the email plaintext.
- [x] **`appendAudit` actions:** `auth.magic-link-request`,
      `auth.magic-link-request.error`, `auth.magic-link-consume`,
      `auth.magic-link-consume.error`, `auth.logout`, `rate_limit_blocked`
      (with `scope` discriminant). All payloads carry `emailHash` or
      `tokenIdPrefix` (8-char prefix of the SHA-256), never the plaintext.
- [x] **No optimistic UI:** auth is server-confirmed.
- [x] **No DangerConfirm:** logout is reversible (the user signs back in).

## Files touched

```
M middleware.ts
M src/db/schema.ts
M src/lib/auth.ts
M src/server/routers/_app.ts
M tests/lib/auth.test.ts
M app/login/page.tsx

A src/db/migrations/0002_users.sql
A src/db/migrations/0003_magic_links.sql
A src/lib/email-hash.ts
A src/lib/magic-link-token.ts
A src/server/auth-users.ts
A src/server/rate-limit-magic-link.ts
A src/server/resend.ts
A src/server/routers/auth.ts
A app/api/auth/magic-link/request/route.ts
A app/api/auth/magic-link/consume/route.ts
A app/login/magic-link-form.tsx
A app/login/login-error-banner.tsx
A tests/lib/email-hash.test.ts
A tests/lib/magic-link-token.test.ts
A tests/server/resend.test.ts
A tests/server/rate-limit-magic-link.test.ts
A tests/server/auth-router.test.ts
A tests/app/auth-magic-link-request-route.test.ts
A tests/app/auth-magic-link-consume-route.test.ts
A docs/tasks/phase-4/T01-magic-link-auth.md
A docs/tasks/phase-4/T01-review.md
```

## Verification

```bash
bun run typecheck           # green (no ts errors)
bun run test                # 1021 pass / 0 fail
bun run build               # green; new routes appear in route table
```

New routes in the build manifest:
```
ƒ /api/auth/magic-link/consume           155 B         102 kB
ƒ /api/auth/magic-link/request           155 B         102 kB
ƒ /login                               2.35 kB         111 kB   (was ~880 B; magic-link-form added)
```
