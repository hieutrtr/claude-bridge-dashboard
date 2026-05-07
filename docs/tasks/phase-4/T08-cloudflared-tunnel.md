# T08 — Cloudflared tunnel via `bun run start --tunnel` *(v2 delta)*

> **Status:** ✅ Done — committed on `main`.
> **Phase 4 invariant satisfied:** the new wrapper introduces no tRPC
> mutation surface, refuses to start with `--tunnel` unless magic-link
> (T01) is reachable + `DASHBOARD_PASSWORD` is strong + non-default,
> and writes nothing to `audit_log` (the spawn happens before any
> tRPC procedure runs). Pure helpers extracted for unit testing;
> `bun test tests/lib/tunnel.test.ts` → 31 pass / 0 fail.
>
> **Source plan:** v2 IMPLEMENTATION-PLAN.md P4-T8 delta (line 106) —
> `--tunnel` lives in `bun run start --tunnel` (dashboard repo)
> instead of the daemon's `bridge dashboard --tunnel` CLI. v1
> ARCHITECTURE.md §8 ("Cloudflared tunnel") + §10
> ("Public exposure misuse") — the security gates encoded by the
> wrapper.

---

## Goal

Let an owner expose a running dashboard to the public internet for
mobile triage / one-off teammate access by adding `--tunnel` to the
existing start command, **without** compromising the auth gates that
make a self-hosted Bridge dashboard safe to expose.

Two acceptance gates per the loop prompt verification block:

1. **`package.json` script exists** — both the canonical
   `bun run start` (replaces the prior `next start` direct invocation)
   and the convenience alias `bun run start:tunnel`.
2. **`--tunnel` flag detected in `start`** — the wrapper parses the
   argv tail bun forwards, flips on tunnel mode, runs the
   refuse-to-start env validation, and spawns `cloudflared tunnel
   --url http://127.0.0.1:<port>` alongside `next start`.

---

## What landed

### 1. Pure helpers (testable)

| File                     | Role                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `src/lib/tunnel.ts`      | `parseStartArgs`, `validateTunnelEnv`, `isDefaultPassword`, `extractTunnelUrl`, `cloudflaredInstallHint`, `MIN_PASSWORD_LENGTH=16`, `DEFAULT_DASHBOARD_PORT=7878`, `TUNNEL_LOCAL_HOST="127.0.0.1"`. |

The helpers are deliberately the only testable surface — they cover
every branching decision the wrapper makes (argv parsing, env gate
verdicts, URL scraping, install-hint dispatch). The wrapper itself
(see below) is a 60-line glue shell over `child_process.spawn`.

### 2. Side-effect wrapper

| File                | Role                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/start.ts`  | Spawns `next start -p <port>`. With `--tunnel`: also spawns `cloudflared tunnel --url http://127.0.0.1:<port>`, scrapes stderr for the trycloudflare URL, prints it. SIGINT/SIGTERM kill both children; exit of either tears down its peer; `cloudflared` ENOENT prints the platform install hint and exits 127. |

### 3. Package wiring

| File           | Change                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `package.json` | `"start": "bun run scripts/start.ts"` (was `"next start"`); new `"start:tunnel": "bun run scripts/start.ts --tunnel"`. |

### 4. Unit tests

| File                          | Coverage                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/lib/tunnel.test.ts`    | 31 cases: argv parsing (default port, --tunnel, --tunnel=cloudflared, --port, unknown-flag passthrough, malformed values, out-of-range ports, unsupported provider rejection), env validation (each gate independently + combined failure), default-password sentinel detection, trycloudflare URL extraction (with bars / without bars / digits-and-hyphens / negative cases), per-platform install hints, constant invariants. |

`bun test tests/lib/tunnel.test.ts` → **31 pass / 0 fail / 77 expect()
calls**. Full sweep `bun test tests/lib tests/app tests/server` → 1318
pass / 0 fail (no regression).

### 5. Docs

| File                       | Role                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                | Adds `bun run start --tunnel` to the run-commands block, surfaces the three required env vars, links to `docs/deploy/tunnel.md`.                                       |
| `docs/deploy/tunnel.md`    | Install (per platform), prerequisites, first-run example, custom port, kill behaviour, security checklist (matches T08 review §1–4), troubleshooting (5 known issues). |

---

## Decisions worth keeping

### (a) `start` rewrites — keep `bun run start` as the canonical entry

The prior `start` script was a direct `next start`. We *could* have
left it untouched and added only `start:tunnel`, but the loop prompt
explicitly verifies "**`--tunnel` flag detected in `start`**" — so
the wrapper sits at `start` and `start:tunnel` is just the alias
`bun run scripts/start.ts --tunnel`. Side benefit: a future flag
(say `--metrics` or `--port-from-env`) lands without rewriting the
script registry.

### (b) Keep `cloudflared` out of dependencies

`qrcode-terminal` (mentioned in the INDEX scope) and `cloudflared`
(the binary) both stay un-bundled. Reasons:

- **`cloudflared`** — vendored binaries balloon the install size by
  ~30 MB and make per-platform packaging the dashboard's problem.
  The user installs it once via brew/apt/winget; we just call it.
- **`qrcode-terminal`** — adds a runtime dep + emoji-grid output that
  many terminals render unevenly. The printed URL is short enough
  (~40 chars) to type or paste; we'll revisit if a phone-pairing
  flow surfaces in v0.2.0.

Recorded in T08 review §6.

### (c) Two refuse-to-start gates, not warn-and-continue

`validateTunnelEnv` returns ALL failures (no short-circuit). The
wrapper prints every line and exits with code `3` *before* spawning
either child. Logic:

- A warning that "magic-link is disabled" is easy to ignore over an
  ssh session; a refusal forces the operator to confront the
  exposure. v1 ARCH §10 flags "public exposure misuse" as the
  highest-impact tunnel risk; gate-then-spawn is the only ordering
  where a misconfigured run never reaches the `cloudflared` exec.

### (d) Default-password sentinels are a small fixed list

`DEFAULT_PASSWORD_SENTINELS = ["password", "changeme", "change-me",
"admin", "owner", "dashboard", "smoke-pass"]`. Case-insensitive,
trim, exact match. Not a regex / dictionary attack — just the
specific strings we know we ship in development fixtures and that
operators commonly leave unchanged. False-negative rate is OK because
the 16-char minimum is the load-bearing gate; the sentinel list
catches the "I padded `password` to 16 chars" cliché.

### (e) URL scraper is regex-only

`extractTunnelUrl` uses one regex against each stderr line (no JSON
parse, no multi-line state machine). Cloudflared sometimes prints the
URL twice (once in the bar-wrapped banner, once in a plaintext "Tunnel
ready" line); the wrapper guards on `urlPrinted` so the public URL
banner appears exactly once.

### (f) Wrapper is intentionally not unit-tested

`scripts/start.ts` calls `child_process.spawn`, wires SIGINT, watches
stdout — every line is a side effect. A unit test would have to mock
`spawn` (and then the test really tests the mock). Per Phase 2/3
precedent (cf. `scripts/email-digest.ts` only tests `runEmailDigest`,
not the CLI shim), we keep the wrapper short, the helpers fat, and
the manual T08 review checklist authoritative for the spawn behaviour.

---

## Files touched

```
A  docs/deploy/tunnel.md
A  docs/tasks/phase-4/T08-cloudflared-tunnel.md
A  docs/tasks/phase-4/T08-review.md
A  scripts/start.ts
A  src/lib/tunnel.ts
A  tests/lib/tunnel.test.ts
M  README.md
M  package.json
```

No router, no migration, no UI surface. Tests added: 31. Tests
removed: 0. Total `bun test` count: 1318 (was 1287).

---

## Manual smoke (T08 acceptance)

The script wrapper itself was not booted end-to-end inside this loop
iteration (no `cloudflared` available in CI/sandbox). The deferred
manual smoke — owner-run before `v0.1.0` tag (T13):

1. `brew install cloudflared` (one-time).
2. Set `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `DASHBOARD_PASSWORD`
   (≥ 16 chars), `JWT_SECRET`.
3. `bun run build`.
4. `bun run start --tunnel`.
5. Confirm a `*.trycloudflare.com` URL prints within 10 s.
6. Open the URL on iPhone over 4G; sign in via magic link.
7. Ctrl-C in the terminal; confirm both children exit and the URL
   stops responding within 5 s.
8. Re-run with `RESEND_API_KEY=""` — confirm refuse-to-start lists
   exactly the missing key.
9. Re-run with `DASHBOARD_PASSWORD="password"` — confirm refuse
   includes both the length and the sentinel error.
10. Uninstall cloudflared (or `PATH=/tmp bun run start --tunnel`) —
    confirm the wrapper prints the install hint and exits 127.

T13 review will note these results before tagging.

---

## Carry-overs / Phase 5 backlog

- **QR-code in terminal.** Optional UX polish — print the URL as a
  QR-code so a phone can scan it without typing. Filed against
  `dashboard@v0.2.0`. Trade-off in §(b) above.
- **Named cloudflared tunnels.** Quick tunnels reset their hostname
  on every run; teams that want a stable URL configure a named
  tunnel in their Cloudflare account. The wrapper could detect a
  `CLOUDFLARED_TUNNEL_NAME` env var and switch from `tunnel --url`
  to `tunnel run <name>`. Filed against v0.2.0.
- **Bind-host audit.** v1 ARCH §10 calls out "dashboard binding
  0.0.0.0" as a parallel exposure path. Today the wrapper relies on
  `next start` defaults (loopback). A defence-in-depth follow-up:
  pass `-H 127.0.0.1` explicitly when `--tunnel` is set, so an env
  override of `HOSTNAME` cannot widen the bind. Tracked in T08
  review §3 carry-over.
