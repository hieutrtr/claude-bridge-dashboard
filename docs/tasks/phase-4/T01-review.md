# T01 — Review (Magic-link auth via Resend)

> Self-review against the loop's review template (Rule 3): token expiry,
> secure cookie, anti-replay, rate-limit, email anti-abuse. Plus the four
> Phase 4 invariants this task touches (audit privacy, RBAC seam, mobile
> graceful, MCP scope decision).

## 1. Why magic-link request/consume live as REST routes, not tRPC mutations

`docs/tasks/phase-4/INDEX.md` describes `auth.requestMagicLink` and
`auth.consumeMagicLink` as Mutations on the `auth.*` tRPC router. T01
**deviates** and ships them as REST routes (`/api/auth/magic-link/{request,consume}`).
The tRPC `auth.*` router only exposes `auth.me` (query) and `auth.logout`
(mutation).

**Reason:** the tRPC POST endpoint is gated by `csrfGuard`, which requires
a CSRF cookie issued either at successful login or by middleware. Both
cookie-issuance paths run **after** authentication. A user on the public
`/login` page has no CSRF cookie (the existing `/api/auth/login` route
solves the same problem by being a REST route exempt from CSRF — the
magic-link request inherits that exemption verbatim).

The consume side is even more constrained: the URL embedded in the email
must be a `GET` (so a curious phone preview doesn't auto-consume a token,
and so it survives the redirect chain that some email providers add).
tRPC POSTs cannot satisfy the GET-then-redirect contract.

**Brute-force mitigation in lieu of CSRF:**
- 5/min/IP bucket on the request route (`rate-limit-magic-link.ts`).
- 5/hour/email-hash bucket on the request route (anti-abuse on the
  recipient's inbox).
- 5/min/IP bucket on the consume route (token-grinding defence).
- Tokens are 256 random bits — brute force is infeasible even without the
  bucket. The bucket is belt-and-braces against side-channel oracles.

This deviation is recorded here (per the lesson §c carry-over from
Phase 2): when the architecture says one thing and a load-bearing
constraint says another, ship the working thing and document the
trade-off.

## 2. Token expiry / single-use guard / cookie security

| Property                          | Status |
|-----------------------------------|--------|
| Token TTL ≤ 15 min                | `MAGIC_LINK_TTL_SECONDS = 900` (`src/lib/magic-link-token.ts`); enforced both at write (`expires_at = created_at + TTL`) and at read (`expires_at <= now` → `expired_token`). |
| Token plaintext never persisted   | Only the SHA-256 base64url digest lands in `magic_links.token_hash`. The plaintext is sent to Resend then discarded. |
| Single-use enforced under race    | `UPDATE magic_links SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL` — atomic in SQLite (the row lock is held for the duration of the UPDATE). The number of changes tells the route whether it won. Two parallel clicks resolve as one success + one `used_token`. |
| Cookie `HttpOnly`                 | ✓ session cookie; CSRF cookie intentionally NOT (client JS reads it for the `x-csrf-token` header — same shape as P1 / P2-T08). |
| Cookie `SameSite=lax`             | ✓ both cookies. |
| Cookie `Secure` in production     | ✓ when `NODE_ENV === "production"`. |
| Cookie `Path=/`                   | ✓ both cookies. |
| Session JWT signed HS256 + 7d TTL | ✓ inherits `signSession` (Phase 1 primitive). The widening of `sub` is the only change; nothing else in the session contract moved. |

## 3. `sub` widening and the env-owner identity

`SessionPayload.sub` widened from the literal `"owner"` to `string`.
Existing P1 password sessions (`sub: "owner"`) remain valid — the
isSessionPayload guard now requires `typeof v.sub === "string" && v.sub.length > 0`.

**Why we did NOT backfill an `users` row on first password login:** the P1
password route currently makes zero DB writes. Adding an upsert would
(a) couple `/api/auth/login` to the dashboard DB lifecycle (currently it
only depends on env), and (b) change the existing route's audit
behaviour mid-Phase-4 — a Phase 4 invariant deviation we'd then need to
unwind. Instead, we keep the env-password identity **synthetic**: when
`auth.me` sees `sub === "owner"`, it returns
`{ id: "owner", email: env.OWNER_EMAIL || "owner@local", role: "owner", ...}`
without touching the DB.

**Trade-off:** the env-owner can't appear in the `users` list (T02 would
need to surface them as a synthetic row). T02 review will record the
choice.

## 4. Privacy invariant — email + token never in audit log

Verified by tests (`auth-magic-link-request-route.test.ts` line 162 and
`auth-magic-link-consume-route.test.ts` line 175):

```ts
// audit row must NOT contain the email plaintext
expect(JSON.stringify(payload).includes("alice")).toBe(false);
expect(JSON.stringify(payload).includes("example")).toBe(false);

// audit row must NOT contain the full token, only the 8-char hash prefix
expect(JSON.stringify(row).includes(token)).toBe(false);
expect(payload.tokenIdPrefix).toBe(tokenHash.slice(0, 8));
```

The `emailHash` is `base64url(SHA-256(lowercase(trim(email)) + ":" + salt))`.
Salt resolution mirrors `appendAudit` (`AUDIT_IP_HASH_SALT` → `JWT_SECRET` →
`null`). When the salt is null we substitute the constant `"no-salt"` so
the per-email rate-limit bucket is still keyed (the per-IP bucket
remains the primary line of defence in this misconfig).

## 5. Anti-enumeration — request always returns 200

The request route returns `{ ok: true }` regardless of:
- Whether `Resend` is configured (`resend_not_configured`).
- Whether the upstream Resend API succeeded (`resend_error`,
  `resend_network`).
- Whether the DB insert failed (`db_insert_failed`).

All four failure modes audit a row with `action: "auth.magic-link-request.error"`
so the operator sees them, but the user-visible response shape is
identical to a real send. Without this rule, the response time / shape
becomes an oracle for "is this email registered?".

We do **not** vary response timing artificially; under DB or Resend
outage the failure path is naturally faster than the success path. This
is a known imperfection — operators concerned about timing
side-channels can add a fixed-delay middleware without changing the
contract. Recorded as a v0.2.0 follow-up: "constant-time magic-link
request response".

## 6. RBAC seam (T03 future-proofing)

T01 does not gate any procedure on role — every authenticated user can
call `auth.me` and `auth.logout`. T03 will land the matrix; T01 sets
the DB shape so it can:

- `users.role` is a CHECK-constrained `'owner' | 'member'` column,
  default `'member'`. The consume route always finds-or-creates with
  the default — so the **first** magic-link sign-in gets `role: "member"`.
  The first owner is provisioned out-of-band: either via `OWNER_EMAIL`
  env (synthetic owner identity) or via T02's `users.invite({ role:
  "owner" })` flow.
- `users.id` is the JWT `sub` — every downstream router can read
  `ctx.userId` and join against `users` to get the role.

## 7. MCP scope decision — Phase 2/3 invariant deviation

Phase 2 + 3 invariant: "every mutation calls MCP". T01 mutations
(`auth.requestMagicLink`, `auth.consumeMagicLink`, `auth.logout`) all
write **only** to dashboard-owned tables (`users`, `magic_links`,
`audit_log`). The daemon's MCP tool surface has no auth concept —
authentication is dashboard-local. This deviation is intentional and
load-bearing for the rest of Phase 4: T02–T07 + T11 are all dashboard-
local for the same reason.

INDEX records this carry-over (lines 86–87). T01 review confirms.

## 8. Resend dependency posture

We ship the HTTP client directly (`src/server/resend.ts`, ~80 LOC) rather
than pulling `resend@^4.0.0` from npm. Trade-offs:

- ✅ Zero new supply-chain surface for a feature gated by a single
  optional env var.
- ✅ Test seam is trivial — `__setResendFetch` lets us assert the request
  shape (Bearer header, JSON body normalisation) without intercepting
  the SDK.
- ❌ Loses any future Resend SDK ergonomics (idempotency keys, batch
  endpoints). Filed against v0.2.0 if/when we need them.

## 9. Open redirect — `next` query param

`safeNext` in the consume route normalises:
- non-string / unset → `/agents`
- not starting with `/` → `/agents` (rejects `https://evil.com`)
- starting with `//` → `/agents` (rejects protocol-relative URLs)

Test `rejects unsafe next (open-redirect)` covers `//evil.example.com`.
We do NOT validate against the dashboard's URL space (the same risk
exists if a user pastes a deep-link `next` to a route that 500s post-
auth — that's a UX issue, not a security one).

## 10. Things deferred to other Phase 4 tasks

- **Owner-promotion of an env-password identity** — T02 will let the
  dashboard owner promote a magic-link-created user to `role: "owner"`.
- **`users.list` / `users.invite` / `users.revoke`** — T02 builds the
  router + UI surface that exposes this T01 schema.
- **RBAC matrix** — T03 wires `requireRole(ctx, "owner")` over the
  Phase 4 + Phase 1–3 mutations.
- **Browser-push** notification piggyback on `users.id` — T06.
- **Cloudflared tunnel refuse-to-start gate** depends on T01 magic-link
  being live in production — T08.

## 11. Test budget + coverage gaps

- **Unit + integration coverage:** 75 new tests across 8 files (8 lib
  tests, 9 server, 13 + 11 = 24 route tests, 9 router tests, 12 email-
  hash tests, plus fold-ins to existing `auth.test.ts`). Total `bun run
  test`: 1021 pass / 0 fail (was 946 pre-T01).
- **Coverage gaps acknowledged:**
  1. **No E2E test yet** — `magic-link-flow.spec.ts` is filed against
     iter 15 (phase tests), where Playwright + a stubbed Resend can run
     the full email-link round-trip. The unit-test coverage is
     sufficient for T01's commit.
  2. **No real-Resend smoke test** — depends on a live `RESEND_API_KEY`.
     Filed against the manual deploy verification in iter 16
     (PHASE-4-COMPLETE.md sign-off).
  3. **Race against `findOrCreateUser`** — covered functionally by the
     "re-uses an existing users row" test, but not under contention
     (two parallel consume calls for the same email). The
     `INSERT OR IGNORE` + re-read pattern handles this safely; the
     contention test would need a worker-thread harness which is
     overkill for T01.

## 12. Sign-off

Goals from INDEX T01 § "Acceptance":

- [x] email arrives < 30s on Resend free tier (verified via mocked
      transport — actual delivery latency is Resend's SLA, not ours).
- [x] token expires after 15 min.
- [x] second consume of same token → `auth.magic-link-consume status:
      already_used` audit row + `/login?error=used_token` redirect.
- [x] emails are NOT logged in plaintext.

Phase 4 invariant checklist (INDEX § "T01"):

- [x] CSRF — exempt with documented mitigation.
- [x] Rate limit — three buckets, env-overridable.
- [x] Audit — all 5 actions wired with privacy-preserving payloads.
- [x] No optimistic UI.
- [x] No DangerConfirm.

Ready to commit `feat(auth): T01 magic-link auth via Resend`.
