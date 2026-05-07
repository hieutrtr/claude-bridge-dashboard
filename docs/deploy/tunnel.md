# Deploy — cloudflared tunnel (`bun run start --tunnel`)

> **Status:** GA in `v0.1.0` (P4-T08). v2 ARCH §7.4 + v1 ARCH §8 +
> §10 "Public exposure misuse" mitigation.

The dashboard ships a `--tunnel` start mode that spawns a [cloudflared](https://github.com/cloudflare/cloudflared)
ephemeral quick tunnel alongside `next start`, printing a public
`*.trycloudflare.com` URL you can hit from a phone or another network.
Both child processes share the parent's lifecycle: a single Ctrl-C
tears down the dashboard *and* the tunnel.

---

## When to use it

Reach for `--tunnel` when:

- You're on call from a phone and want to triage tasks / loops while
  away from a workstation.
- A teammate without VPN access needs a one-off look at a loop result.
- You're demoing the dashboard and don't want to wire up a static
  public hostname.

Reach for [Docker compose](docker.md) (T09) when the dashboard needs
to be reachable continuously, on a stable URL, with TLS terminated
upstream.

---

## Prerequisites

1. **`cloudflared` on PATH.** The dashboard does NOT bundle the binary
   — install it once per machine:

   | Platform | Install command                                                  |
   | -------- | ---------------------------------------------------------------- |
   | macOS    | `brew install cloudflared`                                       |
   | Linux    | Use the deb/rpm packages at <https://pkg.cloudflare.com/>        |
   | Windows  | `winget install --id Cloudflare.cloudflared`                     |

   If `cloudflared` is missing the wrapper exits with code `127` and
   prints the platform-appropriate install hint.

2. **Auth env vars set.** `--tunnel` exposes the dashboard to the
   public internet, so the wrapper enforces three refuse-to-start
   gates BEFORE spawning either child:

   | Env var               | Required value                                                  |
   | --------------------- | --------------------------------------------------------------- |
   | `RESEND_API_KEY`      | Resend project key (free tier is fine for a team < 10).         |
   | `RESEND_FROM_EMAIL`   | A `from` address Resend has verified.                           |
   | `DASHBOARD_PASSWORD`  | ≥ 16 chars; must NOT match a default sentinel like `password`.  |

   The first two keep magic-link login reachable so members can sign
   in without sharing the owner password. The third blocks accidental
   exposure of a development placeholder over the public tunnel.

   The wrapper prints **all** failures in one shot — fix every line
   before retrying.

3. **`JWT_SECRET` set.** Carries over from Phase 1; rotates session
   tokens. Generate once with `openssl rand -hex 32` and store
   alongside `DASHBOARD_PASSWORD`.

---

## First run

```bash
export RESEND_API_KEY="re_live_…"
export RESEND_FROM_EMAIL="dashboard@yourdomain.tld"
export DASHBOARD_PASSWORD="$(openssl rand -base64 24)"
export JWT_SECRET="$(openssl rand -hex 32)"

bun run build
bun run start --tunnel
```

You should see something like:

```
[start] --tunnel mode: spawning next + cloudflared. Press Ctrl-C to stop both.
[start] next start :7878
[start] cloudflared tunnel --url http://127.0.0.1:7878

┌─────────────────────────────────────────────────────────────────
│ Public dashboard URL: https://flat-roses-fix.trycloudflare.com
│ Anyone with this URL can REACH the dashboard. Magic-link / owner
│ password auth still applies — keep RESEND_API_KEY + a strong
│ DASHBOARD_PASSWORD set. Press Ctrl-C to tear down the tunnel.
└─────────────────────────────────────────────────────────────────
```

Open the URL on a phone, log in via magic link or owner password, and
the dashboard works exactly as it does on `localhost:7878`.

---

## Custom port

Pass `--port <n>` to bind a port other than `7878`. The wrapper hands
`-p` through to `next start` and `--url http://127.0.0.1:<n>` to
cloudflared:

```bash
bun run start --tunnel --port 9000
```

---

## Killing the tunnel

`Ctrl-C` in the terminal running `bun run start --tunnel` sends
`SIGINT` to both `next start` and `cloudflared`. If either child exits
on its own, the wrapper kills its peer so you never end up with a
zombie tunnel pointing at a dead Next.js process.

If the tunnel terminal disappears (laptop close, ssh disconnect),
cloudflared releases the `*.trycloudflare.com` hostname automatically
within a few seconds.

---

## Security checklist (T08 review)

The wrapper enforces the following invariants — do not patch around
them:

| Concern                                  | Mitigation                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Brute-force on owner password            | `DASHBOARD_PASSWORD` ≥ 16 chars + non-default sentinel (refuse-to-start).                                 |
| Magic-link unreachable on tunnel         | `RESEND_API_KEY` + `RESEND_FROM_EMAIL` required (refuse-to-start).                                        |
| Tunnel URL leaked into audit log         | Tunnel start happens out-of-process — no tRPC mutation runs, no `appendAudit` row written.                |
| `cloudflared` shell injection            | We `spawn(["cloudflared", "tunnel", "--url", "http://127.0.0.1:" + port])` directly — no shell, fixed args. |
| Dashboard binds 0.0.0.0 by accident      | `next start -p 7878` listens on the configured Next host (default loopback in our wrapper); cloudflared forwards from `127.0.0.1:7878` only. |
| Tunnel survives after `Ctrl-C`           | SIGINT forwarded to both children; if either exits, the wrapper kills its peer.                           |

If you cannot satisfy the gates above, drop `--tunnel` and run
`bun run start` for a localhost-only deployment.

---

## Troubleshooting

**`[start] cloudflared is not on PATH`** — install per the table
above; rerun. The wrapper does not auto-install.

**`refusing to start with --tunnel`** — read the bullet points the
wrapper prints. Each line names exactly one env var to fix.

**Tunnel URL never appears** — cloudflared sometimes takes 5–10 s on
a fresh network. The full stderr stream from cloudflared is
forwarded to your terminal under the `[cloudflared]` prefix; if you
see `Failed to dial` or `connection refused`, your network blocks
outbound HTTPS to Cloudflare's edge. Try a different network or use
the [Docker compose](docker.md) deploy with a static hostname.

**Tunnel works but login fails** — confirm `JWT_SECRET` is set in the
shell that ran `bun run start --tunnel`; the dashboard rejects
unsigned cookies and middleware redirects to `/login` in a loop.
