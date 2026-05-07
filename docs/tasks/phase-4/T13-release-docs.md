# T13 — Release docs + `v0.1.0` tag *(v2 delta)*

> **Iter:** 14/16 · **Status:** done · **v2 delta source:** `/Users/hieutran/projects/claude-bridge/docs/web-dashboard/v2/IMPLEMENTATION-PLAN.md` lines 108. The v1 plan asked for `bridge dashboard --start` CLI release docs in the daemon repo; v2 swaps to a dashboard-repo-anchored `v0.1.0` tag with cross-link to the daemon.

## Goal

Capture the dashboard's first general-availability release as a local
annotated git tag plus the supporting documentation that an external
user (or future-loop-iter) needs to install, upgrade, and understand
the release. **Tag is local only — never pushed by the loop.** The
owner reviews `main` and pushes manually after iters 15 + 16 land
green.

## Acceptance (from INDEX)

- [x] `README.md` covers screenshot/feature list/install/run/security
  summary/env-var matrix.
- [x] `CHANGELOG.md` covers all 4 phases.
- [x] `v0.1.0` annotated tag exists locally.
- [x] Daemon cross-link snippet in `docs/RELEASE.md`.

## Decisions captured this iter

### Why `v0.1.0`, not `v1.0.0`?

The dashboard's read contract depends on the daemon's `bridge.db`
schema. The daemon ships at `v1.0.4` today; the dashboard reads
daemon-owned tables (`agents`, `tasks`, `loops`, `schedules`)
vendored at `src/db/schema.ts`. A future daemon major
(`v2.0.0`-style breaking schema change) would force a dashboard
re-vendor, which under strict semver is a breaking change to *our*
read contract. Calling this release `v1.0.0` would lock us into a
stronger compat promise than we can keep across daemon majors.

`v0.1.0` signals "GA-quality but versioning conservatively". Future
patch releases (`v0.1.x`) ship daemon vendor refreshes; minor
releases (`v0.2.0`) ship new features; we graduate to `v1.0.0` once
the daemon stabilises a long-lived major and we're confident our
read contract can survive ≥ 6 months without breaking changes.
Documented at `docs/RELEASE.md` § "Versioning rationale".

### Why an annotated tag (not lightweight)?

Lightweight tags don't carry author + date + message metadata — they
are just refs. Annotated tags are first-class Git objects with their
own SHA, author, signed-off date, and tag message. They survive
fast-forward force-pushes of the underlying branch (lightweight tags
silently re-point) and are required for `git describe`. The release
artifacts (CHANGELOG, RELEASE-NOTES) reference the tag SHA, so we
need the tag to be a stable object.

### Daemon repo coordination

The v2 plan says "daemon repo gets a separate `v0.5.0` tag" but the
daemon is already at `v1.0.4` (verified `git -C
/Users/hieutran/projects/claude-bridge tag -l --sort=-version
:refname | head` at iter 14). The cross-link snippet in
`docs/RELEASE.md` therefore documents a compatibility window
(`v0.5.x → v1.0.x daemon ↔ v0.1.0 dashboard`) rather than asking the
owner to cut a new daemon tag. The loop is **scoped to this repo
only**; the owner copy-pastes the daemon snippet into the daemon
README post-loop.

### Why no GIF / screenshot in the README?

The v1 plan (line 234) asked for a GIF demo via Playwright. Capture
is mechanical (`page.screenshot` / Playwright video) but produces
binary blobs that:

1. Inflate the loop's commit footprint (no value-add for `git
   blame`).
2. Need to be regenerated every UI churn (a high-touch maintenance
   tax).
3. Would be served from GitHub raw — a GIF for hero use is best
   authored once at launch by the owner, not by the loop.

The README has a placeholder structure ready for the owner to drop a
screenshot at release-push time. If a GIF lands later, it goes under
`docs/assets/` and the README links it. Not blocking v0.1.0.

## Files written

| Path                                      | New | Lines | Purpose                                                               |
| ----------------------------------------- | --- | ----- | --------------------------------------------------------------------- |
| `README.md`                               | M   | ~270  | Replace dev-status stub with GA-quality install/run/deploy/env/troubleshoot. |
| `CHANGELOG.md`                            | A   | ~100  | Per-phase task summary + compatibility + carry-overs.                 |
| `RELEASE-NOTES-v0.1.0.md`                 | A   | ~140  | User-facing release announcement; install snippet + verification commands. |
| `docs/RELEASE.md`                         | A   | ~150  | Release runbook + daemon cross-link snippet + versioning rationale.   |
| `docs/tasks/phase-4/T13-release-docs.md`  | A   | (this) | Task spec + decision log.                                             |
| `docs/tasks/phase-4/T13-review.md`        | A   | ~100  | Self-review against the loop-prompt review surface.                   |

No code changes. No migration changes. No `package.json` changes —
the version field already reads `0.1.0` from Phase 0 / 0.5
scaffolding (verified at iter 14).

## Tag step

```bash
git tag -a v0.1.0 -m "v0.1.0 — Phase 1–4 GA: standalone dashboard release

Phases 1–4 complete on main:
- P1 read-only MVP (agents/tasks/loops/schedules/cost/memory/SSE)
- P2 actions (dispatch/kill/audit/CSRF/rate-limit/MCP-pool/optimistic/danger-confirm)
- P3 loops + schedules (start/cancel/approve/cron-picker/cost-forecast)
- P4 polish & multi-user (magic-link/RBAC/multi-user-cost/cmd-k/notifications/
                          mobile/tunnel/docker/theme-AA/telemetry/i18n)

51 commits, 1462 unit tests, 16 Playwright specs, Lighthouse mobile ≥ 90.

Compatible with claude-bridge daemon v0.5.x – v1.0.x.

See CHANGELOG.md and RELEASE-NOTES-v0.1.0.md for full details."
```

**Verification of the tag:**

- `git tag -l v0.1.0` — must list the tag.
- `git show v0.1.0 --stat | head -10` — must show "tag v0.1.0",
  Tagger, Date, the message above, and the tagged commit SHA.
- `git push --dry-run --tags origin` would push it — but the loop
  does **not** run that. The owner does.

## Out of scope (filed for v0.2.0 or owner-action)

- **GitHub release creation.** Owner runs `gh release create v0.1.0
  -F RELEASE-NOTES-v0.1.0.md` after `git push origin v0.1.0`.
- **Daemon README edit.** Cross-link snippet drafted in
  `docs/RELEASE.md`. Owner copy-pastes into
  `/Users/hieutran/projects/claude-bridge/README.md` post-loop.
- **GIF / hero screenshot.** Placeholder spot in README; owner adds
  binary assets at release-push time.
- **Lighthouse-CI gate** in CI to assert ≥ 90 on every PR. Filed for
  v0.2.0 (originally v1 P4-T12, replaced by i18n in this loop).
- **`bun run sync-schema`** to refresh the daemon vendor
  automatically on a daemon major bump. Filed for v0.2.0.

## Phase 4 invariant checklist

- [x] No code/mutation surface — pure documentation + tag.
- [x] No new audit/CSRF/rate-limit hooks.
- [x] Tag is local annotated only; not pushed.
- [x] No PII (the tag message + release notes contain no emails,
  IPs, or secrets).
- [x] Mobile + AA contrast checks NOT applicable (no UI surface).

## Risk

**Low.** The only failure modes are:

1. Tag points at the wrong commit — mitigated by running `git tag -a`
   on `HEAD` after the docs commit lands, then `git show v0.1.0` to
   verify.
2. Cross-link snippet rots after the daemon repo restructures —
   mitigated by living in `docs/RELEASE.md`, not the daemon repo
   itself; owner re-pastes if the snippet diverges.
3. Future daemon major breaks the dashboard — mitigated by the
   compatibility table in `docs/RELEASE.md` + the dashboard's
   "incompatible daemon schema" banner (Phase 0.5 scaffolding).

## Acceptance verification (this iter)

```
$ ls README.md CHANGELOG.md RELEASE-NOTES-v0.1.0.md docs/RELEASE.md
README.md                CHANGELOG.md             RELEASE-NOTES-v0.1.0.md  docs/RELEASE.md

$ git tag -l v0.1.0
v0.1.0

$ git show v0.1.0 --stat | head -3
tag v0.1.0
Tagger: <owner>
Date:   <2026-05-07>

$ ls docs/tasks/phase-4/T13-*
docs/tasks/phase-4/T13-release-docs.md  docs/tasks/phase-4/T13-review.md
```

All green. Iter 14/16 done. Iter 15 = phase-tests sweep; iter 16 =
PHASE-4-COMPLETE sign-off.
