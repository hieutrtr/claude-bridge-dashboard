# T08 — CSRF middleware — self-review

## Files changed

| File | Lines | Notes |
|------|------:|-------|
| `src/lib/csrf.ts` | +60 / -0 | New: `CSRF_COOKIE`, `CSRF_HEADER`, `issueCsrfToken`, `verifyCsrfToken`. Hand-rolled HMAC-SHA256 over a 16-byte random — no new dependency. |
| `src/server/csrf-guard.ts` | +51 / -0 | New: `csrfGuard(req)` returns 403 / 503 / null. Minimal cookie parser inline (avoids dep). |
| `app/api/trpc/[trpc]/route.ts` | +6 / -3 | Guard runs before `fetchRequestHandler`; GET/HEAD/OPTIONS short-circuit. |
| `app/api/auth/login/route.ts` | +18 / -2 | Issues `bridge_csrf_token` alongside the session cookie on 200; both with `Secure` only in prod. |
| `app/api/auth/logout/route.ts` | +17 / -2 | Guard at top; on success clears both cookies (`Max-Age=0`). |
| `middleware.ts` | +21 / -2 | Backfill: authenticated request without CSRF cookie gets one set on the response. |
| `tests/lib/csrf.test.ts` | +75 / -0 | 11 unit tests (round-trip, tamper, malformed, secret rotation, entropy, non-string). |
| `tests/server/csrf-guard.test.ts` | +127 / -0 | 14 guard tests (safe methods, missing pieces, mismatch, cross-secret, fail-closed 503, cookie parsing). |
| `tests/app/trpc-csrf-route.test.ts` | +75 / -0 | 5 integration tests against the tRPC route (POST blocked, GET exempt, 503 fail-closed, valid pass-through). |
| `tests/app/auth-login-route.test.ts` | +23 / -0 | +1 test asserting CSRF cookie issuance on login success. |
| `tests/app/auth-logout-route.test.ts` | +44 / -8 | Rewritten: now requires CSRF; one test for the 403 path, one for the cleared-both-cookies path. |
| `docs/adr/0001-csrf-strategy.md` | +123 / -0 | New ADR: HMAC double-submit + tRPC POST as sole mutation surface (no Server Actions). |
| `docs/tasks/phase-2/T08-csrf.md` | +136 / -0 | Task spec — acceptance, TDD plan, risk matrix. |
| `docs/tasks/phase-2/INDEX.md` | +1 / -1 | Check off T08. |
| `docs/tasks/phase-2/T08-review.md` | (this) | |

## Test count

- T08 adds **32 tests** (11 + 14 + 5 + 1 + 1 net) across 5 files.
  - `tests/lib/csrf.test.ts` — 11
  - `tests/server/csrf-guard.test.ts` — 14
  - `tests/app/trpc-csrf-route.test.ts` — 5
  - `tests/app/auth-login-route.test.ts` — +1
  - `tests/app/auth-logout-route.test.ts` — net +1 (had 1, now has 2)
- Suite total: **299 pass / 0 fail / 875 expects** (267 baseline + 32 = 299).
- `bun run typecheck` clean. `bun run build` clean (Next.js 15.5.15,
  middleware bundle 35.2 kB).

## TDD trail

The unit tests for `src/lib/csrf.ts` and the guard tests for
`src/server/csrf-guard.ts` were written first. The integration test
in `trpc-csrf-route.test.ts` was authored against the existing
`route.ts` and asserted 403 — which trivially failed against the
unguarded handler (it would have returned a tRPC error or 200, not
a 403). Implementing the guard turned all tests green in a single
pass. No bug-hunt cycle needed; the guard is small enough that the
spec → impl mapping is direct.

## Self-review checklist

- [x] **Tests cover happy + error path** — every failure mode of the
      guard has a test (no cookie / no header / mismatch / wrong-secret /
      missing JWT_SECRET / safe methods exempt / cookie among other
      cookies / empty cookie value).
- [x] **Mutation has audit log entry?** — N/A: T08 is the entry guard,
      not a mutation. Audit log is T04, called by mutation procedures
      (T01/T03/T06/T09) once they land.
- [x] **CSRF token check?** — This task IS the CSRF check. ✓
- [x] **Rate limit applied?** — N/A: T07 is the next task and stacks
      on top of T08 in the same `route.ts` entry.
- [x] **Optimistic update with rollback?** — N/A: backend guard only.
- [x] **Confirmation pattern for destructive action?** — N/A: T11
      (UI guard for kill / cancel) is a separate task.
- [x] **No secret leak** — `JWT_SECRET` is only read by
      `readAuthEnv()` and passed into `crypto.subtle` for HMAC. The
      guard's 403 response body is a static string `{"error":"csrf_invalid"}`
      — no debugging info, no token echo, no header echo. The guard
      does NOT log anything (deliberately — log noise on failed CSRF
      can become a side channel for attackers probing the app).

## Acceptance verification (per task spec §Acceptance criteria)

| # | Criterion | How verified |
|---|-----------|--------------|
| 1 | Token issued on login + middleware backfill, never on 4xx | `auth-login-route.test.ts` "issues a CSRF cookie alongside the session"; the existing 401/400 tests remain (no new Set-Cookie on those — the route returns the error response without touching cookies). Middleware backfill is exercised by inspection — its branch is gated on `payload !== null`, the same branch that already passed Phase 1 auth tests. |
| 2 | Token format = `<base64url>.<base64url>` HMAC-SHA256 | `csrf.test.ts` "round-trips" asserts the shape. |
| 3 | Verification on tRPC mutation (cookie + matching header + valid signature) → else 403 | `csrf-guard.test.ts` covers each branch; `trpc-csrf-route.test.ts` covers the wire-up. |
| 4 | Logout requires CSRF | `auth-logout-route.test.ts` "rejects logout without a CSRF token". |
| 5 | Login is exempt | Existing login tests do not require CSRF; the route does not call the guard. ADR §3 documents the rationale. |
| 6 | GET/HEAD/OPTIONS exempt | `csrf-guard.test.ts` has explicit cases for each. `trpc-csrf-route.test.ts` "GET … bypasses CSRF guard". |
| 7 | `JWT_SECRET` unset → 503, fail closed | `csrf-guard.test.ts` "returns 503 when JWT_SECRET is unset" + "503 takes precedence over csrf_invalid". |
| 8 | ADR documenting choices | `docs/adr/0001-csrf-strategy.md` written. |

## Design notes

- **Reuses `timingSafeEqual` from `src/lib/auth.ts`** — both for the
  cookie-vs-header byte-equality check and for the HMAC signature
  compare. One implementation, one place to audit.
- **Cookie parser is inline.** Avoids pulling `cookie`/`cookies-next`
  deps for a single needle-in-haystack lookup. The parser does
  `split(';') → trim → check name`, which is correct for all
  RFC 6265 cookie strings the browser will produce. (It would not
  handle quoted values with embedded `;` — a corner case the
  browser will not generate for our base64url tokens.)
- **`Response.json()` (Web standard) instead of `NextResponse.json`**
  in the guard. The guard runs from both the tRPC route AND the
  logout route AND (potentially) future Server Action handlers
  (forbidden by ADR but harmless to be portable). `Response.json` is
  Next-agnostic and Web-standard, no dep on `next/server`.
- **`SameSite=Lax` + signed token** — defense in depth. Lax already
  blocks third-party POSTs in modern browsers; the signed double-
  submit covers same-site subdomain-takeover and edge cases where
  Lax leaks (top-level GET that triggers fetch).
- **No per-session binding (yet).** Phase 4 multi-user adds a
  `web_sessions` table, at which point `verifyCsrfToken` should be
  extended with a session-id claim baked into the HMAC input. The
  current implementation is forward-compatible — `issueCsrfToken`
  signs only the random part, so adding a `(random, sessionId)`
  tuple is a non-breaking extension as long as old tokens are
  invalidated at the rotation event.
- **Why `bridge_csrf_token` (not `__Host-csrf`)** — the
  `__Host-` prefix demands `Path=/`, no `Domain`, and `Secure`. We
  set `Path=/` and conditionally `Secure`, so production cookies
  qualify, but development (HTTP localhost) does not — using the
  prefix would split dev/prod cookie names. We keep the unprefixed
  name and rely on the explicit cookie attributes.

## Risks + caveats (carry-forward)

1. **No CI guard against Server Actions.** The ADR forbids
   `"use server"` in this codebase. Reviewer discipline only — a
   `tools/check-no-server-actions.ts` grep guard is a follow-up.
   Tracked for Phase 4 hardening (PHASE-2-COMPLETE.md backlog).
2. **`bun:test` does not exercise the Next.js `middleware.ts`
   directly.** The middleware backfill branch is verified by
   reasoning about its diff (the only added code path is gated on
   `payload !== null`, which Phase 1 tests already prove is
   reachable). A full Playwright spec covering "open / on a session
   without csrf cookie / make a mutation succeed" lands in the
   Phase 2 E2E sweep at slot 14.
3. **Token rotation = no automatic.** A 7-day token is fine for
   Phase 2's threat model, but a stolen non-HttpOnly cookie is
   reusable for that window. XSS protection (CSP, sanitised
   markdown — already present from Phase 1) is the relevant
   mitigation. Phase 4 multi-user revisits.
4. **Login route has no rate limit yet.** ADR §3 calls out that
   login does not need CSRF because rate-limit gates it. T07 is the
   next loop slot — the rate-limit landing brings the guarantee
   home. Not a T08 bug.
5. **`getSetCookie()` requires Node 20+ / Bun.** Used in tests; the
   project's `package.json` already pins Node ≥ 20 and Bun ≥ 1.1
   per existing tooling. No risk.
6. **No XSRF-TOKEN client helper in the dashboard yet.** The
   client-side fetch wrapper that reads the cookie and adds the
   `x-csrf-token` header doesn't exist yet — it's not needed until
   T01 mounts a real mutation. The cookie is in place; the matching
   header will be added by the tRPC link config in T01. Until then,
   the guard's correctness is observable from the integration tests
   (the cookie + header are constructed manually).
