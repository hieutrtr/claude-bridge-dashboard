# P2-T08 — CSRF double-submit cookie middleware

> Mutation entry guard. Lands at slot 3/15 (after T12 transport,
> before T07 rate-limit and T04 audit). Every state-changing HTTP
> request that lands on the dashboard MUST pass this guard before it
> reaches a tRPC procedure or a mutation route handler.

## References

- v1 ARCH §10 — *"CSRF: tRPC POST endpoints; check `Origin` header
  matches; double-submit cookie for state-changing actions"* — this
  task implements the **double-submit cookie** layer. (`Origin`/`Host`
  check is folded in as a defense-in-depth.)
- v2 ARCH §6 (Auth) — JWT cookie session is HTTP-only + SameSite=Lax;
  CSRF cookie added here is **NOT** HttpOnly (client JS must read it).
- INDEX §"Open architectural concerns" §d.4 — ADR locks tRPC POST as
  the only mutation surface; Server Actions are NOT used in this app.
- `docs/PHASE-2-REVIEW.md` §c risk-tier (T08 = **Medium**) — the risk
  is the Next.js Server-Actions / tRPC-POST mismatch; we resolve by
  banning Server Actions.

## Acceptance criteria

1. **Token issuance.** A non-HttpOnly cookie `bridge_csrf_token` is
   issued:
   - On `POST /api/auth/login` 200 response (alongside the session
     cookie).
   - By the route-level middleware on **any** authenticated GET
     request that lacks a CSRF cookie (so existing sessions and SSR
     pages backfill the token without forcing a re-login).
   - Never on a 4xx auth-failure response.
   The cookie is `Path=/`, `SameSite=Lax`, `Secure` in production,
   `Max-Age = SESSION_TTL_SECONDS` (matches session lifetime).
2. **Token format.** Hand-rolled HMAC-SHA256: token =
   `base64url(random16) + "." + base64url(hmac(random16, JWT_SECRET))`.
   No external dependency. Verified by `verifyCsrfToken(token, secret)`
   using `timingSafeEqual` on the signature (constant-time).
3. **Verification on mutations.** Every non-idempotent HTTP request
   (POST / PUT / PATCH / DELETE) that hits the tRPC entry
   `app/api/trpc/[trpc]/route.ts` MUST present:
   - the cookie `bridge_csrf_token`, AND
   - a request header `x-csrf-token` whose value **byte-equals** the
     cookie, AND
   - that value MUST also pass `verifyCsrfToken()` against the
     server's `JWT_SECRET` (i.e. an attacker who could forge a known
     non-signed cookie is still rejected).
   Any failure → HTTP **403** with body `{ "error": "csrf_invalid" }`.
   No tRPC handler runs.
4. **Verification on logout.** `POST /api/auth/logout` is
   state-changing and MUST be CSRF-checked. Same 403 surface as
   tRPC.
5. **Login is exempt.** `POST /api/auth/login` is the bootstrap
   call: by definition the user has no session cookie yet, so we
   cannot bind a CSRF token to that session. Login is protected
   instead by the future T07 rate-limit (5/min/IP). Documented in
   the ADR.
6. **GET / HEAD / OPTIONS are exempt.** Read-only methods don't
   need a CSRF check (and tRPC v11 batched queries via GET would
   otherwise break).
7. **No bypass on misconfiguration.** If `JWT_SECRET` is unset, the
   guard fails-closed — every mutation returns 503
   `{ "error": "auth_not_configured" }`. (Same posture as Phase 1
   login.)
8. **ADR.** `docs/adr/0001-csrf-strategy.md` documents:
   - Choice: hand-rolled HMAC double-submit (over `csrf-csrf` /
     `csurf` deps) — keeps dependency surface small.
   - Choice: tRPC POST is the **only** mutation surface; Next.js
     Server Actions are forbidden in this codebase.
   - Choice: secret = `JWT_SECRET` (same trust domain; one secret
     to rotate).
   - Choice: cookie name = `bridge_csrf_token` (parallels
     `bridge_dashboard_session`).
   - Choice: not bound to per-session — any valid signed token
     accepted. (Per-session binding deferred — needs persistent
     session table; phase 4.)

## Non-goals

- Server Action protection (Server Actions are forbidden — see ADR
  §3). If/when a future task introduces one, this guard will need
  to be re-applied at a different boundary.
- Per-session token binding. Current threat model: any signed token
  is accepted. An attacker who steals the cookie via XSS already has
  the session cookie too — CSRF is not the right defense for that.
  Per-session binding deferred to Phase 4 when a `web_sessions`
  table backs the token.
- Token rotation on every request. The same token is valid for the
  session lifetime (7 d). Rotation is a future concern.
- SameSite=Strict on the session cookie — kept at `Lax` so deep
  links from email/Telegram still work. Defense lies in the CSRF
  header check.

## TDD plan (RED → GREEN)

### Unit — `tests/lib/csrf.test.ts`

1. `issueCsrfToken(secret)` returns a string with shape
   `<base64url>.<base64url>` and round-trips through
   `verifyCsrfToken`.
2. Token signed with secret A is **rejected** by verifier with
   secret B.
3. Tampering the random part flips the signature → rejected.
4. Tampering the signature → rejected.
5. Malformed inputs (`""`, `"a"`, `"a.b.c"`, `"a.b.c.d"`) → rejected
   without throwing.
6. `issueCsrfToken("")` throws (mirrors `signSession` behaviour).
7. `verifyCsrfToken("anything", "")` throws.
8. Two consecutive `issueCsrfToken(secret)` calls produce different
   tokens (random16 entropy) — guards against constant-token bug.

### Unit — `tests/server/csrf-guard.test.ts`

The guard helper takes a `Request` and returns either a `Response`
(403/503) or `null` (pass).

1. GET request → returns `null` (exempt).
2. OPTIONS / HEAD → returns `null`.
3. POST without cookie → returns 403 `{error: "csrf_invalid"}`.
4. POST with cookie, missing header → 403.
5. POST with header that does not match cookie → 403.
6. POST with matching cookie + header but token signed with wrong
   secret → 403.
7. POST with matching, validly-signed cookie + header → returns
   `null`.
8. `JWT_SECRET` unset → 503 `{error: "auth_not_configured"}`.
9. PUT / PATCH / DELETE → same enforcement as POST.

### Integration — `tests/app/trpc-csrf-route.test.ts`

Drives the actual `app/api/trpc/[trpc]/route.ts` POST handler.

1. tRPC POST without CSRF header → 403, body
   `{"error":"csrf_invalid"}`.
2. tRPC POST with valid cookie+header → reaches the router (verify
   by calling a known cheap query like `agents.list` proxied via
   POST batch link) and returns 200.
3. tRPC GET (a query) → bypasses CSRF guard → 200.

### Integration — `tests/app/auth-login-route.test.ts` (extend)

Add: login success Set-Cookie header includes both
`bridge_dashboard_session=` and `bridge_csrf_token=`. New cookie
has `SameSite=Lax`, `Path=/`, `Max-Age=SESSION_TTL_SECONDS`, and
**not** `HttpOnly`.

### Integration — `tests/app/auth-logout-route.test.ts` (extend)

Add: logout without CSRF header → 403 (and session cookie is NOT
cleared). With valid CSRF → 200, both cookies cleared.

## Implementation outline

### `src/lib/csrf.ts`

```ts
export const CSRF_COOKIE = "bridge_csrf_token";
export const CSRF_HEADER = "x-csrf-token";

export async function issueCsrfToken(secret: string): Promise<string>;
export async function verifyCsrfToken(
  token: string, secret: string,
): Promise<boolean>;
```

- 16-byte random buffer via `crypto.getRandomValues`.
- HMAC-SHA256 signature using existing `crypto.subtle` (mirrors
  `auth.ts`).
- Reuses `timingSafeEqual` from `auth.ts` for the signature compare.

### `src/server/csrf-guard.ts`

```ts
export async function csrfGuard(req: Request): Promise<Response | null>;
```

- Reads method; bails for GET / HEAD / OPTIONS.
- Reads `JWT_SECRET` via `readAuthEnv()`; missing → 503.
- Reads `Cookie` header, parses `bridge_csrf_token=…` minimal
  parser (no external dep — same idea as `next/headers` cookies but
  Request-scoped here).
- Reads `x-csrf-token` header; `timingSafeEqual` against cookie.
- Calls `verifyCsrfToken`; on failure → 403.
- Returns `null` to indicate "pass through".

### Wire-up

- `app/api/trpc/[trpc]/route.ts` — guard runs before
  `fetchRequestHandler`. (GET path remains untouched.)
- `app/api/auth/login/route.ts` — issue CSRF cookie on success.
- `app/api/auth/logout/route.ts` — guard at the top; on success
  clear both cookies.
- `middleware.ts` — backfill: if request has a valid session cookie
  but **no** `bridge_csrf_token`, set one on the response. Lifts
  the cost of a manual re-login for users who already had a session
  before T08 deployed.

## Risk + mitigation

| Risk (from PHASE-2-REVIEW §c.T08) | Mitigation in this task |
|-----------------------------------|-------------------------|
| Server Actions side-stepping the tRPC POST guard | ADR §3 forbids Server Actions. CI grep guard deferred — flagged as a follow-up in `T08-review.md`. |
| Cookie set without `Secure` on prod by accident | Wire-up uses `process.env.NODE_ENV === "production"` (same conditional as session cookie). Test asserts the conditional explicitly. |
| Token guessable | 128-bit random + HMAC-SHA256 signature. Forging requires `JWT_SECRET`. |
| Header set by malicious origin via fetch | Browser fetch-from-other-origin won't include `x-csrf-token` set by attacker JS — that header isn't on the CORS safelist, and the dashboard does NOT enable cross-origin. The cookie + header combo means: attacker page can include the cookie (browsers attach it on same-site POSTs), but cannot read it (HttpOnly is False but cross-origin JS still can't read another site's cookies). The attacker also cannot set the matching header via a cross-origin form POST. Hence the double-submit invariant holds. |
| Misuse: future Server Action introduced silently | ADR §3 + sign-off checklist; no tooling check yet. |
| `JWT_SECRET` rotation invalidates outstanding CSRF cookies | Acceptable: rotating the secret is a credentialled-event; users re-auth and get a new CSRF cookie. Documented in ADR §6. |
