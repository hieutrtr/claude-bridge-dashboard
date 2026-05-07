# T08 — Code review (cloudflared tunnel via `--tunnel`)

> Self-review against the Phase 4 review-rule template (auth / RBAC /
> mobile / email-rate-limit). T08 sits in the **security-review** axis
> — the four numbered subsections below mirror the v1 ARCH §10
> "Public exposure misuse" mitigation list, plus two T08-specific
> concerns (process lifecycle + dependency surface).

---

## 1. Auth — is auth always-on under tunnel?

**Yes — refuse-to-start gate enforced.**

`scripts/start.ts` runs `validateTunnelEnv(process.env)` BEFORE
spawning either `next start` or `cloudflared`. The validator returns
`ok=false` with at least one error when any of the following is
missing or weak:

- `RESEND_API_KEY` empty/unset → magic-link login would fall back to
  the owner password only, which is the brute-force surface we're
  trying to keep behind a strong gate.
- `RESEND_FROM_EMAIL` empty/unset → Resend API rejects requests with
  no verified sender; magic-link would 500 and leave the owner
  password as the only entry path.
- `DASHBOARD_PASSWORD` empty → unauthenticated dashboard exposure;
  refuse outright.
- `DASHBOARD_PASSWORD` shorter than `MIN_PASSWORD_LENGTH = 16` →
  brute-forceable over the cloudflared edge in well under a year of
  attempts; v1 ARCH §10 mandates 16-char floor for tunnel mode.
- `DASHBOARD_PASSWORD` matches one of `DEFAULT_PASSWORD_SENTINELS`
  (`password`, `changeme`, `change-me`, `admin`, `owner`,
  `dashboard`, `smoke-pass`) → cliché placeholder; refuse.

The validator returns ALL failures (no short-circuit) so a
misconfigured operator sees every blocker in one print and can fix
them in one cycle. Verified by `tests/lib/tunnel.test.ts` describe
block "validateTunnelEnv" → "returns ALL failures (does not short-circuit)".

The session signing primitive (`signSession`/`verifySession`) and
middleware redirect-to-/login are **inherited from Phase 1 + P4-T01**
— the wrapper does not create a new auth surface, does not bypass
middleware, does not issue tokens. Anything reaching the public URL
hits the same `middleware.ts` gate `localhost:7878` does.

## 2. RBAC — does the 403 matrix cover all mutation routes?

**N/A — T08 introduces no tRPC procedure.**

The wrapper script is OS-level glue: it spawns two processes and
forwards signals. No tRPC router, no zod input, no `appendAudit`
call. The RBAC matrix from T03 (`tests/server/rbac-matrix.test.ts`)
remains the single source of truth for who can call what; tunnel
mode does not widen or narrow it.

The tunnel flips on/off the *transport reach* of the dashboard
(loopback only vs. public). The authorisation surface that controls
which user can hit which procedure is unchanged.

## 3. Mobile — Lighthouse ≥ 90?

**Yes — inherited from T07; no regression possible.**

T08 ships zero UI. The tunnel just forwards HTTP to the same Next.js
server T07 audited. Slow-4G + 4× CPU throttle scores from the T07
Lighthouse summary (`docs/tasks/phase-4/lighthouse/summary.json`) —
perf 96–99, a11y 98–100, BP 96 — apply unchanged.

Manual phone test is part of the T08 deferred smoke (step 6 of the
task file). Outcome will be captured in T13 review before tagging.

## 4. Email rate-limit — anti-abuse?

**N/A locally — inherited from T01 + reinforced by gate §1.**

Magic-link rate-limit (5/min/IP + 5/hour/email-hash, P4-T01) runs at
the tRPC `auth.requestMagicLink` mutation. It applies identically
under tunnel: the cloudflared edge forwards client IPs in the
`CF-Connecting-IP` / `X-Forwarded-For` headers, which the rate-limit
key derivation in `src/server/rate-limit-magic-link.ts` already
honours via `req.headers.get("x-forwarded-for")` (Phase 4 P4-T01
review §3, captured in `magic-link-token.ts` IP-hash test).

The T08 `RESEND_API_KEY` refuse-to-start gate is the *defensive*
backstop: even if rate-limit were misconfigured, an unset Resend key
yields zero outbound emails, capping abuse cost at zero.

---

## Additional T08-specific concerns

### 5. Process lifecycle — do we leak children on parent exit?

**No — bidirectional teardown wiring.**

`wireSignals` in `scripts/start.ts` traps `SIGINT` and `SIGTERM` and
forwards them to every child handle, with a 500 ms grace period
before `process.exit`. `bindChildExit` reverses the relationship —
when *either* child exits unexpectedly, the wrapper kills its peer.
That guarantees:

- Ctrl-C in the operator's terminal → both children die → process
  exits.
- `next start` crashes → `cloudflared` is killed → wrapper exits with
  the child's code.
- `cloudflared` crashes (network blip) → `next start` is killed →
  wrapper exits non-zero so a supervising tool (systemd, pm2) can
  decide whether to restart.

Edge case: if the user closes the terminal without sending SIGINT
(SSH disconnect mid-session), the controlling-tty hangup propagates
SIGHUP → both children inherit it → both die. Standard POSIX
behaviour, not something we need to special-case.

### 6. cloudflared dependency surface — shell injection? install hint?

**Direct argv (no shell), platform-specific install hint.**

The cloudflared spawn uses `spawn("cloudflared", ["tunnel", "--url",
"http://127.0.0.1:" + port])` with no shell flag, so the only
operator-controlled value is `port`, which is parsed through
`parsePort` (integer, range `[1, 65535]`). Injection surface: zero.

When `cloudflared` is not on PATH, `bindChildExit` catches the
ENOENT, prints `cloudflaredInstallHint(process.platform)` (brew /
deb / winget / generic releases URL), kills any peer, and exits 127.
The hint table is unit-tested for darwin / linux / win32 / fallback.

We intentionally do NOT vendor the cloudflared binary — vendored
binaries balloon the install size by ~30 MB and tie us to per-platform
release cadence. The README + `docs/deploy/tunnel.md` document the
one-time install per machine.

---

## Carry-overs / open items

1. **Bind-host hardening.** Today we trust `next start` defaults to
   bind loopback. A subtle env override (e.g., `HOSTNAME=0.0.0.0`)
   could widen the bind, defeating the "tunnel only path to public"
   model. Defence-in-depth follow-up: when `--tunnel` is set, pass
   `-H 127.0.0.1` explicitly to `next start`. Filed for v0.2.0
   (low-risk because Next.js default is `0.0.0.0` only when no host
   is configured AND a port flag is given without `-H` AND the
   process inherits an empty `HOSTNAME` — operationally rare but
   worth tightening).
2. **QR-code printing.** INDEX scope mentioned `qrcode-terminal`. We
   skip it for v0.1.0 (added dep, terminal-rendering noise).
   Re-evaluate if a phone-pairing UX surfaces.
3. **Named tunnels.** Quick tunnels reset their hostname every run;
   teams wanting a stable URL configure a Cloudflare-account-owned
   named tunnel. The wrapper could detect `CLOUDFLARED_TUNNEL_NAME`
   and switch from `tunnel --url` to `tunnel run <name>`. Filed
   v0.2.0.
4. **Manual smoke deferred.** No `cloudflared` binary in this loop's
   sandbox; the 10-step manual smoke in the task file runs before
   T13 tags `v0.1.0`. T13 review captures the outcome.

Final verdict: **safe to merge**. Refuse-to-start gates encode the
v1 ARCH §10 mitigation; injection surface is closed; lifecycle is
bidirectional; no UI / mutation / migration delta to bisect later.
