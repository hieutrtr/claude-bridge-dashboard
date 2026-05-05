# T07 — Rate-limit middleware — self-review

## Files changed

| File | Lines | Notes |
|------|------:|-------|
| `src/lib/rate-limit.ts` | +97 / -0 | New: `createBucket`, `consume`, `_resetBuckets`, `_bucketCount`. Token-bucket primitive with lazy GC; `now` is injectable for deterministic tests. |
| `src/server/rate-limit-mutations.ts` | +95 / -0 | New: `rateLimitMutations(req, sessionUserId)` — 30/min/user (or per-IP fallback). Returns 429 + `Retry-After` + JSON body. `_reset()` debug helper. |
| `src/server/rate-limit-login.ts` | +75 / -0 | New: `rateLimitLogin(req)` — 5/min/IP. Always keyed on IP (pre-session). Same 429 surface. |
| `app/api/trpc/[trpc]/route.ts` | +34 / -3 | Stacks `rateLimitMutations` after `csrfGuard`; reads session subject from JWT cookie via `verifySession`, falls back to IP for unauthenticated mutation attempts. |
| `app/api/auth/login/route.ts` | +6 / -0 | `rateLimitLogin(req)` runs before `readAuthEnv()` and body parsing — so malformed-body and wrong-password attempts still spend the bucket. |
| `app/api/auth/logout/route.ts` | +24 / -1 | Stacks `rateLimitMutations(req, sub)` after `csrfGuard`; reads session subject locally (logout has its own copy of the subject reader). |
| `tests/lib/rate-limit.test.ts` | +109 / -0 | 10 unit tests (capacity, refill, retry-after, multi-key, GC, disabled, reset). |
| `tests/server/rate-limit-mutations.test.ts` | +127 / -0 | 8 guard tests (exempt methods, userId vs IP keying, x-forwarded-for first-hop, x-real-ip fallback, 429 shape, env-disabled). |
| `tests/server/rate-limit-login.test.ts` | +75 / -0 | 5 guard tests (5-pass + 6th-deny, IP isolation, missing-IP fallback, env-disabled). |
| `tests/app/trpc-rate-limit-route.test.ts` | +91 / -0 | 4 integration tests (30 pass + 31st-429, GET unaffected, CSRF-precedence). |
| `tests/app/auth-login-route.test.ts` | +43 / -3 | +2 tests: 6th request → 429; rate-limit applies before body parsing. Existing tests now include a default `x-forwarded-for` so the bucket key is deterministic, and `_reset()` runs in `beforeEach`. |
| `docs/tasks/phase-2/T07-rate-limit.md` | +135 / -0 | Task spec — acceptance, TDD plan, risk matrix. |
| `docs/tasks/phase-2/INDEX.md` | +1 / -1 (status) + +1/-1 (T07 tick) | Iter 4/15 status; check off T07. |
| `docs/tasks/phase-2/T07-review.md` | (this) | |

## Test count

- T07 adds **29 tests** across 5 files (10 + 8 + 5 + 4 + 2 net).
- Suite total: **328 pass / 0 fail / 2398 expects** (baseline 299 → 328).
- `bun run typecheck` clean. `bun run build` clean (Next.js 15.5.15;
  middleware bundle still 35.2 kB).
- Per the loop's verification clause: 30 successes + the 31st rejection
  is asserted twice — once at the guard layer
  (`tests/server/rate-limit-mutations.test.ts` "31st POST in the same
  minute") and once at the wired tRPC entry
  (`tests/app/trpc-rate-limit-route.test.ts` "rejects the 31st with
  429"). Login: 5 successes + 6th rejection is asserted at both layers
  (`tests/server/rate-limit-login.test.ts` + `tests/app/auth-login-route.test.ts`).

## TDD trail

The `rate-limit.test.ts` lib tests were written first; the initial GC
test failed because the original eviction predicate required
`tokens >= capacity`, but a freshly-consumed entry stays at
`tokens = 0` until its next consume. Replacing the predicate with
"any entry idle ≥ 10 min — recreating it would yield identical state
on consume, so dropping is safe" turned that test green and is the
correct semantics. Mutation- and login-guard tests were authored
against module imports that did not yet exist (`Cannot find module`
RED), then went green with a single implementation pass each.
Integration tests against the route handlers were added after the
guard primitives went green and required only the route wire-up.

## Self-review checklist

- [x] **Tests cover happy + error path** — every branch exercised:
      bucket exhaustion, refill, multi-key isolation, env-disabled
      mode, missing IP headers, GC, fail-safe (`unknown` bucket),
      and the wire-up at both `/api/trpc/*` and `/api/auth/login`
      surfaces.
- [x] **Mutation has audit log entry?** — N/A yet: T04 has not
      landed. The 429 path has a one-line forward note in the spec
      (`// TODO(T04): appendAudit(rate_limit_blocked, ...)`).
      T04 will wire it in without touching the guard.
- [x] **CSRF token check?** — Stacked correctly. CSRF runs before
      rate-limit; integration test "CSRF takes precedence over
      rate-limit" asserts the order (no CSRF → 403 even when bucket
      exhausted).
- [x] **Rate limit applied?** — This task IS the rate-limit. ✓
- [x] **Optimistic update with rollback?** — N/A: backend guard.
- [x] **Confirmation pattern for destructive action?** — N/A: T11
      is a separate task.
- [x] **No secret leak** — the 429 response body is a static
      `{"error":"rate_limited","retryAfterSec":<int>}`. `Retry-After`
      header echoes the same integer. No timing oracle on bucket
      identity (the bucket key is computed from already-public
      headers / cookie subject — not derived from secrets). The
      guard does not log on deny — log noise on rate-limit denials
      is itself a side channel for an attacker probing the cap.

## Acceptance verification (per task spec §Acceptance criteria)

| # | Criterion | How verified |
|---|-----------|--------------|
| 1 | Token bucket primitive (`createBucket`, `consume(b, key, now?)`) | `tests/lib/rate-limit.test.ts` — 10 cases including injectable `now`. |
| 2 | Bucket math: 30 cap / 0.5 r-p-s for mutations; 5 cap / 0.0833 r-p-s for login; deny → `retryAfterSec = ceil((1 - tokens)/refill)` | `tests/lib/rate-limit.test.ts` "retryAfterSec is ceil((1 - tokens) / refillPerSec)" — exact 0.5 r-p-s case. Login refill is exercised by the 6th-deny test. |
| 3 | Memory bound — GC drops idle entries | `tests/lib/rate-limit.test.ts` "evicts idle full buckets after 10 minutes" — 1500 keys → < 1024 after GC. |
| 4 | Mutation guard: keying, fallback, 429 surface | `tests/server/rate-limit-mutations.test.ts` (8 cases) + `tests/app/trpc-rate-limit-route.test.ts`. |
| 5 | Login guard: 5/min/IP, fail-closed, 429 surface | `tests/server/rate-limit-login.test.ts` (5 cases) + 2 new login-route integration tests. |
| 6 | GET / queries unaffected | `tests/app/trpc-rate-limit-route.test.ts` "GET queries are not rate-limited" (100 GETs in a row). |
| 7 | Logout rate-limited via mutation guard | Wire-up at `/api/auth/logout/route.ts`; reuses `verifySession` to read subject; falls back to IP. Coverage piggy-backs on the existing T08 logout integration test (still passes; the 1-call rate ≤ 30/min). |
| 8 | Process-singleton — `globalThis` cache | `STATE_KEY` lives on `globalThis`; HMR-safe. `_reset()` clears the cached state and the bucket entries. |
| 9 | Tunable via env | `RATE_LIMIT_MUTATIONS_PER_MIN=0` and `RATE_LIMIT_LOGIN_PER_MIN=0` disable; tested in both unit and integration. |
| 10 | Audit-log placeholder for 429 | Spec carries the `// TODO(T04)` note — guard surfaces deny via the response, leaving the audit-write to T04 (which knows the schema). |

## Design notes

- **Stacking order at the tRPC entry: CSRF → rate-limit → handler.**
  CSRF runs first because it's the cheapest and rejects unauthenticated
  attackers without spending a token slot. Rate-limit then keys on the
  authenticated user (or IP fallback) — stacking the other way would
  let an attacker without a CSRF token still spend the bucket and
  starve a legit user.
- **Per-IP bucket for login is shared at the IP, not per-user.** This
  matches v1 ARCH §10 and the threat model: pre-session, the only
  proxy-stable identity is the IP. NAT'd users behind a single egress
  IP share a 5/min budget — acceptable for an owner-only deployment
  (single user). Multi-user revisits in Phase 4 with a per-user
  `failed_attempts` table.
- **`globalThis` cache vs module-level `let`.** Next.js dev server
  routinely re-evaluates ESM modules across HMR boundaries. A
  module-level `let` would lose state mid-session; the `globalThis`
  cache survives. Production builds compile to a single module
  evaluation, so the choice is a no-op there but matters for dev.
- **`Response` (Web standard) vs `NextResponse`.** Both guards return
  a Web-standard `Response` so they're portable to non-Next handlers
  (route handlers, middleware, future Server Action boundary if the
  ADR-§3 ban is ever lifted). `Retry-After` is a standard HTTP header
  and surfaces in the browser dev-tools without further wiring.
- **Why not `Math.ceil(retryAfterSec)` only.** The implementation
  uses `Math.max(1, Math.ceil(...))` so a tiny-fractional negative
  token state (numerical noise) cannot return `0` on a deny — a deny
  always tells the client to wait at least one second, never "you can
  retry immediately". (Without the floor, a mutation client that
  retries at `Retry-After=0` would re-spam.)
- **No SSE bucket.** SSE is GET and is gated by the session check
  upstream. A dedicated bucket would only matter if SSE became a
  resource-amplification vector — out of scope for Phase 2.
- **No `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers.** Two
  reasons: (a) they leak the policy to attackers, who can then time
  their attacks just below the cap; (b) clients that need adaptive
  backoff can read `Retry-After`. Trade-off documented; revisit in
  Phase 4 if a proper API client demands the headers.
- **GC predicate.** "Idle for ≥ 10 min → drop, regardless of token
  count." An idle entry would refill to capacity by the next consume
  anyway, so dropping and recreating is identical — the simpler
  predicate. The eager GC trigger on `entries.size > 1024` ensures
  pathological bursts don't grow unbounded between the 64-consume
  cadences.

## Risks + caveats (carry-forward)

1. **In-memory only — multi-replica drift.** Single-process invariant
   for Phase 2. Phase 4 (Docker compose) needs a SQLite or Redis
   backing. Flag carried into `PHASE-2-COMPLETE.md`.
2. **`x-forwarded-for` trust.** First-hop only, assuming a reverse
   proxy in front. A direct-to-Node deployment (no proxy) collapses
   all unproxied calls to a single `"unknown"` bucket — fail-safe
   under DDoS, not fail-open. Documented in the task spec.
3. **No audit row on 429 yet** (T04 not landed). Stub note in code
   and spec; T04 fills it in.
4. **Login bucket can starve a legit user behind NAT.** Acceptable
   for owner-only deployment; multi-user revisits.
5. **No load-test harness yet.** The acceptance "load test 50 req/s
   → 30 success, 20 reject" from v1 IMPL §P2-T7 is verified
   functionally (consume-30-then-deny) but not against a wall-clock
   load generator. Phase 2 E2E sweep (slot 14) is the right place
   for that — flagged as a follow-up if not picked up there.
6. **`bun:test` reuses processes across files** so the singleton
   bucket state can bleed across test files. Mitigated by every
   T07 test calling `_reset()` (or a `freshModule()` re-import) in
   `beforeEach`. Existing T08 tests still pass because they don't
   make >30 mutation requests in a single test.
7. **`RATE_LIMIT_*_PER_MIN=0`** is a debug escape hatch that
   silently disables protection. Documented in the task spec; a
   prod readiness checklist for Phase 4 should fail-deploy if
   either is set to 0.
