# Release process

The dashboard ships as a standalone repo with its own semver tags
(`v0.1.0`, `v0.2.0`, …). Tags are **always** annotated and **never**
pushed automatically — the owner reviews the local tag and pushes
manually after sign-off.

This file is the runbook.

---

## Pre-flight (every release)

1. `git checkout main && git pull --ff-only` — be on a clean main.
2. `bun install` — pick up any lockfile delta.
3. `bun run typecheck` — must be silent (0 errors).
4. `bun run test` — must be all green (`pass` count ≥ baseline; see
   `CHANGELOG.md` for the previous tag's count).
5. `bun run build` — must compile with no errors. Note the First Load
   JS sizes; if any route ballooned, investigate before tagging.
6. `bun run test:e2e` — Playwright must pass. Cold runs take ~25s per
   spec; allow up to 10 minutes locally.
7. `bun run lighthouse:mobile` — every route ≥ 90 P/A11y/BP/SEO.
   Reports land under `docs/tasks/phase-<N>/lighthouse/`. Compare
   against the previous release; flag any regression.
8. **Smoke test in a browser.** `bun run start`, sign in, click
   through every nav route, ⌘K, theme toggle, language switcher.
   Mobile viewport (DevTools 390×844). Read pages with daemon offline
   (`pkill -f claude-bridge`) — should not crash.

---

## Cut the release

Authoring step-by-step (replace `v0.X.0` and the message):

```bash
# 1. Update CHANGELOG.md — move "Unreleased" to "v0.X.0" with today's date.
# 2. Write RELEASE-NOTES-v0.X.0.md (copy template from v0.1.0).
# 3. Bump package.json `version` to match the tag (no leading `v`).
# 4. Commit:
git add CHANGELOG.md RELEASE-NOTES-v0.X.0.md package.json README.md
git commit -m "docs: vX.Y.Z release notes + bump"

# 5. Tag (annotated, signed if you have a key):
git tag -a v0.X.0 -m "vX.Y.Z — <one-line release theme>"

# 6. Verify the tag points at the right commit:
git show v0.X.0 --stat | head -40
git tag -l v0.X.0 -n5

# 7. NOTHING IS PUSHED YET.
```

The owner reviews the local tag against `main`, then pushes manually:

```bash
git push origin main
git push origin v0.X.0
```

Do **not** push tags from a loop / agent / scheduled job. The push
must be a deliberate owner action so the GitHub release can be
authored alongside.

---

## After the push

1. **GitHub release.** Copy `RELEASE-NOTES-v0.X.0.md` into the GitHub
   release body for the tag. Attach screenshots if available.
2. **Daemon README cross-link.** If this is the first release or the
   compatibility window changed, update the daemon's README with the
   snippet below.
3. **Roadmap.** Move the items from "Out of scope" / "Known
   limitations" into GitHub issues labelled `v0.<next>.0` so the next
   loop has a punch list.

---

## Daemon repo cross-link snippet

Paste this section into the daemon repo
(`/Users/hieutran/projects/claude-bridge/README.md`) under a new
`## Dashboard` header. The dashboard repo and daemon repo version
independently — this snippet just tells daemon users where to find
the matching dashboard.

````markdown
## Dashboard

A web dashboard ships as a separate repo:
[`claude-bridge-dashboard`](https://github.com/hieutrtr/claude-bridge-dashboard).

It reads `~/.claude-bridge/bridge.db` and the daemon's MCP socket to
show agents, tasks, loops, schedules, cost analytics, and audit log
in a browser. Magic-link auth + RBAC + cloudflared tunnel deploy land
in `v0.1.0`.

```bash
# Install the latest dashboard (pin a tag)
git clone https://github.com/hieutrtr/claude-bridge-dashboard
cd claude-bridge-dashboard && git checkout v0.1.0
bun install
bun run build && bun run start          # http://127.0.0.1:7878
```

| Daemon version | Dashboard versions known to work |
| -------------- | -------------------------------- |
| `v0.5.x`       | `v0.1.0`                         |
| `v1.0.x`       | `v0.1.0`                         |

If you bump the daemon and hit an "incompatible daemon schema" banner
in the dashboard, file an issue at the dashboard repo with both
versions; we'll cut a `v0.1.x` patch with the updated vendor.
````

---

## Versioning rationale

- **Why v0.1.0 and not v1.0.0 for the first GA?** The dashboard read
  contract depends on the daemon's `bridge.db` schema, which is still
  on `v1.0.x` itself but has shipped only one stable line so far.
  Calling the dashboard `v1.0.0` would imply API stability we cannot
  promise across daemon major bumps. `v0.1.0` signals "GA-quality but
  versioning conservatively" — patch releases (`v0.1.x`) ship daemon
  vendor refreshes; minor releases (`v0.2.0`) ship new features; we
  graduate to `v1.0.0` after the daemon hits a stable major-major
  contract.
- **Patch vs minor vs major.**
  - **Patch (`v0.1.x`)** — daemon vendor refresh, security fix, bug
    fix. No new features, no breaking config change.
  - **Minor (`v0.X.0`)** — new feature shipped behind an env var or
    additive UI. May add a new column to dashboard-owned tables (with
    a forward-compatible migration). Roadmap items (push, telemetry
    upload, onboarding wizard, ICU plurals) ship here.
  - **Major (`v1.0.0`)** — breaking change to the daemon read
    contract, the auth scheme, or the public env surface. Telegraphed
    via at least one minor with a deprecation notice.
- **Decoupled from daemon.** A daemon `v1.0.0 → v2.0.0` jump does
  **not** force a dashboard major. The dashboard cuts `v0.<n+1>.0`
  with the new vendor + a compat note.

---

## What `v0.1.0` actually shipped (this release)

Per [`CHANGELOG.md`](../CHANGELOG.md): Phases 1–4 of the v1 / v2
implementation plan, 51 task commits on `main`, 1462 unit/integration
tests pass, 16 Playwright specs pass, Lighthouse mobile ≥ 90 across
11 routes. Authored over four loop runs (Phase 1: 2026-05-05; Phase
2: 2026-05-06; Phase 3: 2026-05-06; Phase 4: 2026-05-07).

The local annotated tag was created in iter 14/16 of the Phase 4
loop. Iter 15 runs the full phase test sweep + browser test; iter 16
writes `PHASE-4-COMPLETE.md` and lands the sign-off commit. The owner
pushes the tag after iter 16 verifies green.
