# P2-T07 — Rate-limit middleware (token bucket)

> Mutation entry guard. Lands at slot 4/15 (after T12 transport and T08
> CSRF). Pairs with T08 at the same HTTP boundary: every state-changing
> request that lands on the dashboard MUST pass T08 (CSRF) **and** T07
> (rate-limit) before it reaches a tRPC procedure or a mutation route
> handler. The login route gets a stricter, IP-keyed bucket because
> there is no session yet.

## References

- v1 ARCH §10 — *"Brute-force login: Rate-limit `/auth/*` route: 5
  req/phút/IP (in-memory token bucket). Sau 5 lần fail consecutive →
  cooldown 15 phút."*  Rate-limit policy. We implement the **5/min/IP
  on `/login`** half here; the consecutive-fail cooldown is a later
  refinement (Phase 4).
- v1 IMPL §P2-T7 — *"30 mutation / phút / user; 429 response chuẩn.
  Acceptance: load test 50 req/s → 30 success, 20 reject 429."* —
  per-user bucket for mutations.
- INDEX §"Open architectural concerns" §d.3 — pre-auth rate limit
  (5/min/IP for `/login`) confirmed in T07.
- INDEX §"Multi-replica rate-limit" — single-process in-memory only;
  Phase 4 (Docker compose) migrates to SQLite or Redis. Documented in
  `PHASE-2-COMPLETE.md`.
- `docs/PHASE-2-REVIEW.md` §c risk-tier (T07 = **Low**) — single-process
  is the only real risk; we accept it for Phase 2.
- T08 wire-up at `app/api/trpc/[trpc]/route.ts` — T07 stacks immediately
  after `csrfGuard` returns null.

## Acceptance criteria

1. **Token bucket primitive.** `src/lib/rate-limit.ts` exports a
   reusable `createBucket({ capacity, refillPerSec })` factory and a
   `consume(bucket, key, now?)` operation. The `now` parameter is
   injectable so tests can drive the clock without `setTimeout`. The
   bucket is keyed by an arbitrary string (user id, IP, or composite).
2. **Bucket math.**
   - `capacity = 30`, `refillPerSec = 30 / 60 = 0.5` for the mutation
     bucket.
   - `capacity = 5`, `refillPerSec = 5 / 60 ≈ 0.0833…` for the login
     bucket.
   - Each `consume()` call decrements the bucket by 1 if `tokens >= 1`,
     and returns `{ ok: true, remaining, retryAfterSec: 0 }`. If the
     bucket is empty, `consume()` returns
     `{ ok: false, remaining: 0, retryAfterSec }` where
     `retryAfterSec = Math.ceil((1 - tokens) / refillPerSec)`.
   - Tokens accrue continuously via the refill rate, capped at
     `capacity`. `now` is read from `Date.now()` by default; tests
     override.
3. **Memory bound.** The bucket map is bounded — buckets that have
   been at full capacity for ≥ 10 min and have not been touched are
   evicted on the next `consume()` (lazy GC). In a 50 req/s burst we
   never grow beyond `capacity * activeKeys` integers, and the GC
   removes stale entries (test asserts entry count stays < 1024).
4. **Mutation guard.** `src/server/rate-limit-mutations.ts` exports
   `rateLimitMutations(req, sessionUserId)` returning `Response` (429)
   or `null`. Key = `sessionUserId` (the JWT `sub`) when authenticated,
   falling back to the IP (read from `x-forwarded-for` or
   `x-real-ip`; trimmed first hop). 429 response body =
   `{ "error": "rate_limited", "retryAfterSec": <int> }` and the
   `Retry-After: <int>` header. Wired at the tRPC POST entry,
   immediately after `csrfGuard` returns `null`.
5. **Login guard.** `src/server/rate-limit-login.ts` exports
   `rateLimitLogin(req)` returning `Response` (429) or `null`. Key =
   IP only (login is pre-session). Same 429 surface as the mutation
   guard. Wired at the **top** of `app/api/auth/login/route.ts` —
   before body parsing, before `readAuthEnv()` — so a flood of
   malformed-body requests still spends the bucket.
6. **GET / queries unaffected.** The mutation guard short-circuits on
   `req.method === "GET"` (and HEAD/OPTIONS) — symmetric with T08.
   tRPC GET batched queries do not consume tokens. Documented + tested.
7. **Logout is rate-limited via the mutation guard.** Re-using the
   tRPC mutation bucket would require the user id, which logout has;
   for simplicity we apply `rateLimitMutations` at the top of
   `/api/auth/logout/route.ts` (after `csrfGuard`) using the session
   subject from the JWT cookie. Falls back to IP if the cookie is
   absent. Auditable as `mutation` traffic from the same user.
8. **Process-singleton.** A single in-memory bucket map per Node
   process. `globalThis` cache is used so HMR / dev-server reloads
   don't reset state mid-request — but tests can call
   `_resetBuckets()` (debug-only export) to start fresh.
9. **Tunable via env.** `RATE_LIMIT_MUTATIONS_PER_MIN` (default 30)
   and `RATE_LIMIT_LOGIN_PER_MIN` (default 5) read at module init.
   Setting either to `0` disables the bucket (returns `null`
   unconditionally) — a debug escape hatch documented but not
   required to ship.
10. **Audit-log placeholder.** A `rate_limit_blocked` row is
    audit-logged on every 429 once T04 lands. T07 ships with a
    one-line `// TODO(T04): appendAudit(...)` and a stub call site
    that will be filled in T04. T07 does NOT take a hard dep on the
    audit table existing.

## Non-goals

- Multi-replica / distributed rate limiting (deferred to Phase 4).
- Sliding-window or fixed-window algorithms (token bucket only).
- Per-route customisable limits beyond the mutations / login pair.
  We do **not** add a 3rd bucket for SSE — SSE is GET-side and is
  protected by Phase 1's session check.
- 5-consecutive-fail cooldown on login (15-minute lock-out). Refinement
  for Phase 4 once the audit table feeds it.
- Returning `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers. A
  follow-up; not required for the policy.

## TDD plan (RED → GREEN)

### Unit — `tests/lib/rate-limit.test.ts`

1. `createBucket({capacity:5, refillPerSec:1})` starts full —
   `consume(b, "k", 0)` returns `{ok:true, remaining:4}`.
2. Five rapid `consume` calls at the same `now` exhaust the bucket;
   the 6th returns `{ok:false, retryAfterSec:1}`.
3. After 1 second of refill, the 6th call now succeeds with
   `remaining = 0` (capacity − 1 since +1 token has accrued).
4. Refill caps at capacity — waiting 1 hour does not grant 3600 tokens;
   after the 6th refill-and-consume the bucket is back at `capacity-1`.
5. Two distinct keys are independent — exhausting `"a"` does not block
   `"b"`.
6. `retryAfterSec` is `Math.ceil((1 - tokens) / refillPerSec)`,
   never zero on a deny, and is monotonically non-increasing as
   `now` increases (sanity: never returns a negative value).
7. `refillPerSec = 0.5` (mutation policy): consuming all 30 then
   waiting 2 s grants 1 token; `retryAfterSec` reported on a deny
   immediately after exhaustion is 2.
8. Memory bound: 1500 distinct keys, each consumed once, then 11
   minutes pass → next `consume` triggers GC; `_bucketCount()` < 1024.
9. `_resetBuckets()` clears all keys for a fresh test.
10. Disabled bucket (`capacity = 0`) — every `consume` returns
    `{ok:true}` (escape hatch for the env-disabled path).

### Unit — `tests/server/rate-limit-mutations.test.ts`

The mutation guard reads from a Request, picks a key, and calls into
`consume`.

1. GET → returns `null` (exempt).
2. POST with `sessionUserId` provided → bucket key = userId.
3. POST without session → key falls back to IP from
   `x-forwarded-for` (first hop, trimmed).
4. POST with no `x-forwarded-for` and no `x-real-ip` → key = literal
   string `"unknown"`.
5. 31st POST in the same minute (same userId) → 429 with
   `Retry-After` header and JSON body
   `{error:"rate_limited", retryAfterSec: <int>}`.
6. Two distinct user ids each get their own bucket (60 calls total
   across two users still all pass).
7. Setting `RATE_LIMIT_MUTATIONS_PER_MIN=0` disables the guard
   (every call returns `null`). [env-rebind: tests set then
   `_reloadConfig()` debug helper.]

### Unit — `tests/server/rate-limit-login.test.ts`

1. POST `/api/auth/login` with IP in `x-forwarded-for` → keys
   on that IP.
2. 5 consecutive POSTs from the same IP all pass; the 6th is 429.
3. A different IP is unaffected.
4. Body is irrelevant: a malformed body still spends a token (the
   guard runs before parsing).
5. Setting `RATE_LIMIT_LOGIN_PER_MIN=0` disables the guard.

### Integration — `tests/app/auth-login-route.test.ts` (extend)

Add: 6th rapid request from the same IP returns 429 *without*
calling `readAuthEnv` or attempting password compare — verified by
asserting body shape and that `set-cookie` is absent.

### Integration — `tests/app/trpc-rate-limit-route.test.ts`

1. 31st valid-CSRF tRPC POST in a minute (same session) returns
   429, body `{error:"rate_limited", ...}`, `Retry-After` header set.
2. tRPC GET is not rate-limited (1000 GETs in a row pass).
3. 429 path is reached *after* CSRF — POST with valid CSRF token but
   exhausted bucket → 429. POST without CSRF, regardless of bucket,
   → 403 (CSRF wins, because it runs first).

## Implementation outline

### `src/lib/rate-limit.ts`

```ts
export interface BucketOpts { capacity: number; refillPerSec: number }
export interface ConsumeResult { ok: boolean; remaining: number; retryAfterSec: number }

export function createBucket(opts: BucketOpts): Bucket;
export function consume(bucket: Bucket, key: string, now?: number): ConsumeResult;

// Debug-only — used by tests. Not exported from the package surface.
export function _resetBuckets(): void;
export function _bucketCount(bucket: Bucket): number;
```

- Internal entry: `{ tokens: number; updatedAtMs: number }` per key.
- Refill on read: at consume time, compute `elapsed = (nowMs - updatedAtMs) / 1000`,
  `tokens = min(capacity, tokens + elapsed * refillPerSec)`,
  then deduct 1 if available.
- GC: every Nth consume (N = 64), iterate map; drop entries where
  `tokens >= capacity` and `nowMs - updatedAtMs > 10*60*1000`.

### `src/server/rate-limit-mutations.ts`

- Module-init reads `process.env.RATE_LIMIT_MUTATIONS_PER_MIN` (default
  30); `0` → disabled mode.
- Single shared `mutationBucket = createBucket({capacity: N, refillPerSec: N/60})`.
- `rateLimitMutations(req, sessionUserId?)`:
  - Bail if method ∈ {GET,HEAD,OPTIONS}.
  - Bail if `disabled`.
  - Pick key: `sessionUserId ?? clientIp(req) ?? "unknown"`.
  - `consume(...)`. On `!ok` → return 429 (`Response.json` + headers).
  - Else return `null`.
- `clientIp(req)`: `x-forwarded-for` first hop → fallback `x-real-ip`
  → null. Trim and validate non-empty.

### `src/server/rate-limit-login.ts`

- Same shape as the mutation guard, with `capacity =
  RATE_LIMIT_LOGIN_PER_MIN ?? 5`, `refillPerSec = capacity / 60`.
- Always keys on IP (login is pre-session).

### Wire-up

- `app/api/trpc/[trpc]/route.ts` — between `csrfGuard` and
  `fetchRequestHandler`. Reads the session subject from the JWT cookie
  (re-uses `verifySession` from `src/lib/auth.ts`). If session is
  invalid, falls back to IP.
- `app/api/auth/login/route.ts` — `rateLimitLogin(req)` at the very top
  of the handler; before any other work.
- `app/api/auth/logout/route.ts` — after `csrfGuard`, call
  `rateLimitMutations(req, sub?)`.

## Risk + mitigation

| Risk (from PHASE-2-REVIEW §c.T07) | Mitigation in this task |
|-----------------------------------|-------------------------|
| **In-memory only — multi-replica drift.** | Single-process invariant (Phase 2 ships single-process). Migration to SQLite/Redis flagged in `PHASE-2-COMPLETE.md` for Phase 4. |
| **Memory grows unboundedly per IP.** | Lazy GC drops full + idle buckets on every Nth consume; test asserts <1024 entries after a 1500-key burst. |
| **Trusting `x-forwarded-for` blindly.** | First-hop only; documented assumption: a reverse proxy (nginx / Vercel edge) sits in front. Any direct connection to the Node server uses the IP `req.headers["x-real-ip"]` set by the proxy, falling back to `"unknown"` (which pools all unproxied calls into a single bucket — fail-safe under DDoS, not fail-open). |
| **Token leak across tests** (process-singleton). | `_resetBuckets()` debug export called in `beforeEach`. |
| **Race with HMR / dev reload.** | `globalThis.__bridge_rate_limit__` cache survives module re-evaluation. |
| **Login bucket starves a legit user behind a NAT** (5/min/IP shared by many users). | Acceptable for Phase 2 owner-only deployment (single user). Phase 4 multi-user revisits with per-user-id login attempts table. |
| **No audit row on 429 yet** (T04 not landed). | `// TODO(T04)` placeholder; T04 wires it in. T07 still ships with the working guard. |
| **Disabling via env is a foot-gun in prod.** | `RATE_LIMIT_*_PER_MIN=0` documented as a debug-only escape. ADR/INDEX both note that production deployments must not set it. |
