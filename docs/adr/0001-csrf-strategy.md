# ADR 0001 — CSRF strategy: HMAC double-submit + tRPC POST as the sole mutation surface

**Status:** Accepted (Phase 2 — 2026-05-06)
**Owners:** Bridge Dashboard
**Supersedes:** none
**Superseded by:** none

## Context

The Phase 1 dashboard was read-only (queries only via tRPC). Phase 2
adds mutations: dispatch, kill, loop approve/reject, permission
allow/deny, and audit log writes. Mutations carry CSRF risk.

Two questions to answer:

1. **What CSRF mechanism?** Synchronizer token, double-submit cookie,
   or `Origin` check alone?
2. **What is the mutation entry surface?** tRPC POST only, or also
   Next.js Server Actions, or also bare API route handlers?

The wider context:

- Auth is a single-user JWT cookie session
  (`bridge_dashboard_session`, HttpOnly, SameSite=Lax). One env-var
  `JWT_SECRET`.
- The app already standardises on tRPC v11 for all server
  procedures.
- We want the smallest dependency footprint we can defend (Phase 4
  will revisit when multi-user lands).
- Browsers default `SameSite=Lax`, which already blocks third-party
  POSTs in modern browsers — but defense in depth matters because
  GET-triggered requests, embed/iframe edge cases, and same-site
  subdomain takeovers can all leak past `SameSite=Lax`.

## Decision

### 1. Mechanism: signed double-submit cookie

We issue an HMAC-signed token in a cookie `bridge_csrf_token`
(non-HttpOnly so JS can read it), and require the same token in
the `x-csrf-token` request header on every state-changing
request.

The token format is `base64url(random16) "." base64url(hmac(random16, secret))`,
where `secret = JWT_SECRET`.

Verification on a mutation:

1. Read cookie `bridge_csrf_token`.
2. Read header `x-csrf-token`.
3. Both must be present.
4. They must `timingSafeEqual`.
5. The shared value must verify against `JWT_SECRET`.

Failure → 403 `{"error":"csrf_invalid"}`. No tRPC handler runs.

**Why signed (not just random):** A plain random double-submit is
defeated if an attacker can write a cookie on a sibling subdomain
(rare but real — DNS hijack, HSTS preload gap, vulnerable
sub-app). Requiring the token to verify against `JWT_SECRET` means
the attacker also has to know `JWT_SECRET` to forge a token, which
is a credentialled compromise — at that point CSRF is the least
of our worries.

**Why not `csurf` / `csrf-csrf` library:** small dep surface goal;
the entire mechanism is ~80 lines of code we control. Reuses the
HMAC primitives we already wrote in `src/lib/auth.ts`. If the threat
model expands (per-session binding, multi-user, rotation), we
revisit and consider a library at that point.

### 2. tRPC POST is the only mutation surface

Next.js 13+ App Router introduces **Server Actions** as a parallel
mutation surface. Server Actions submit `multipart/form-data` to a
hidden endpoint; the framework's CSRF protection is `Origin` check
+ same-host check. That works, but it splits the mutation surface
into two systems with different guards.

To keep one guard for one place we make the following calls:

- **All mutations go through tRPC.** Route handlers may exist only
  for non-state-changing concerns (SSE stream, OAuth callback if
  ever). The two existing route handlers
  (`/api/auth/login`, `/api/auth/logout`) are auth bootstrap, not
  domain mutations:
  - login is exempt by definition (no session yet).
  - logout MUST CSRF-check (same guard as tRPC).
- **Server Actions are forbidden.** No file in this codebase may
  contain `"use server"` at the top of a server-side function or a
  `<form action={…}>` pointed at a Server Action. Reviewers enforce
  this manually for Phase 2; a CI grep guard is a follow-up.

**Rationale for "no Server Actions":** the app is mostly an
admin/observability tool, not a content site; it benefits from
fewer mutation surfaces, not from incremental hydration via Server
Actions. tRPC's typed surface gives us better DX for the same
work.

### 3. Login is exempt

`POST /api/auth/login` is the bootstrap call. The user has no
session yet, so a per-session CSRF token cannot exist before this
call resolves. Rather than introduce a "pre-session" CSRF (which
adds complexity for one route), we exempt login and rate-limit it
(T07: 5 req/min/IP).

A CSRF attack on login would mean: tricking a user into "logging
in" with credentials they don't know. The result is the user gets
a session as the attacker — useless for the attacker. The threat
model does not motivate a CSRF guard on login.

### 4. Cookie attributes

- `Path=/` — needs to be readable by all routes.
- `SameSite=Lax` — same as session cookie; lets deep-link GETs
  succeed.
- `Secure` in production (matches session cookie's conditional).
- `HttpOnly=False` — required so client JS can read the value to
  populate the `x-csrf-token` header on each fetch. This is the
  cost of double-submit.
- `Max-Age = SESSION_TTL_SECONDS` (7 days) — matches the session
  TTL so they expire together.

### 5. Token issuance

Tokens are issued in three places:

1. `POST /api/auth/login` 200 response (alongside the session
   cookie). Primary path for new users.
2. `middleware.ts` — for an authenticated request that lacks the
   CSRF cookie, append a Set-Cookie to the response. Backfill path
   for existing sessions at deploy time.
3. (Implicit) Logout clears both cookies; the next login re-issues.

### 6. Secret rotation

Rotating `JWT_SECRET` invalidates all outstanding session tokens
*and* CSRF tokens. Because secret rotation is already an
"everyone re-authenticates" event for sessions, no special
handling for CSRF is needed.

## Consequences

- **Positive:** Single guard, one place to audit. Small dep
  surface. Reuses HMAC code already in the repo.
- **Positive:** Forbidding Server Actions removes a class of
  "guard mismatch" bugs.
- **Negative:** Future engineers may want Server Actions for a
  feature; they have to either route the feature through tRPC or
  revisit this ADR.
- **Negative:** No per-session binding — a stolen CSRF cookie
  remains valid for 7 d. Acceptable because the session cookie
  alone is already sufficient for any same-site attacker; CSRF
  protects only against off-site attackers, who lack both.
- **Negative:** No CI grep enforcing "no Server Actions". Reviewer
  discipline for now; tooling guard is a backlog item.

## Alternatives considered

- **`Origin` header check alone.** Rejected: `Origin` is not always
  present (older browsers, fetch with no body, navigations). Used
  as defense in depth in the future, not as primary guard.
- **`csurf` (express-style) middleware.** Rejected: extra
  dependency for a primitive we can write in 80 lines. Revisit
  when multi-user binding is needed.
- **Synchronizer-token-pattern (server-side stored).** Rejected:
  requires a token store. Phase 2 has no DB-backed sessions yet
  (single-user mode); adding a store just for CSRF is
  disproportionate.
- **Server Actions with `Origin` check.** Rejected: see decision §2.

## Open follow-ups

- **CI grep for Server Actions** (forbid `"use server"`). Tracked
  as a Phase 4 hardening item.
- **Per-session CSRF binding** when `web_sessions` table lands
  (Phase 4 — multi-user).
- **CSRF cookie rotation on every mutation** — only worth doing
  if BREACH-style attacks become relevant (Phase 4).
