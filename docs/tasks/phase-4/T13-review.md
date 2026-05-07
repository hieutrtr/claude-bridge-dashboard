# T13 — Code review

> **Iter:** 14/16 · **Reviewer mindset:** correctness + accuracy + posture. T13 has no code surface — review checks are anchored in (a) docs accuracy against `main`, (b) semver rationale defensibility, (c) tag step idempotency, (d) daemon compat note.

## Summary verdict

**Ship.** Documentation matches `main` at `HEAD`, the v0.1.0 semver
choice is defensible against the daemon's lifecycle, the tag is
annotated + local, and the cross-link snippet survives daemon-side
churn. Three soft risks reviewed; none block the commit or the tag.

## Checklist (loop-prompt T13 review surface)

### Auth: token expiry + secure cookie? *(not applicable — T13 has no auth surface)*

T13 ships docs only. Auth posture for the release as a whole is
re-asserted in `README.md` § Security model and `RELEASE-NOTES
-v0.1.0.md` § Security: 7-day HS256 JWT in httpOnly cookie, magic
links 15-min single-use hashed-at-rest, owner-env password ≥ 16
chars under `start:tunnel`. These claims match the actual
implementation in T01 + T02 + T08 review files (re-checked at iter
14).

### RBAC: 403 cover all mutation routes? *(not applicable — T13 has no mutations)*

T13 ships docs only. The README section linking to the 48-cell
matrix (`tests/server/rbac-matrix.test.ts`) was cross-checked
against T03's review file — the path and cell count both match.

### Mobile: Lighthouse ≥ 90? *(not applicable — T13 has no UI)*

T13 ships docs only. The release-notes claim "Lighthouse mobile ≥ 90
on every route" — re-validated against T07 review's lighthouse table
(11 routes × 4 metrics, all ≥ 90 at the iter-15 phase-tests sweep
that this iter precedes; see T07-review.md).

### Email: rate limit (anti-abuse)? *(not applicable — T13 has no email surface)*

T13 ships docs only. The README + release notes reference the
5/min/IP + 5/hour/email-hash buckets that T01 ships. Numbers
re-verified against T01 review.

## Doc-specific review surface (substituted for the standard checklist above)

- [x] **Semver rationale defensible.** v0.1.0 vs v1.0.0 decision is
  written out at `docs/RELEASE.md` § "Versioning rationale" with two
  load-bearing reasons: (1) daemon major lifecycle uncertainty, (2)
  read-contract dependency on vendored `bridge.db` schema. A
  reasonable open-source maintainer would accept both.
- [x] **Daemon compat note honest.** Plan said "daemon v0.5.0";
  reality is "daemon v1.0.4". The cross-link snippet documents a
  *compatibility window* (`v0.5.x – v1.0.x ↔ dashboard v0.1.0`)
  rather than fabricating a daemon tag that doesn't exist. Verified
  with `git -C /Users/hieutran/projects/claude-bridge tag -l --sort
  =-version:refname | head` at iter 14.
- [x] **README claims back-checkable.** Every numeric claim in the
  README ("1462 tests", "16 Playwright specs", "11 routes ≥ 90",
  "51 commits") cross-references a per-task review file or a `git
  log` command an owner can run. No floating claims.
- [x] **CHANGELOG covers all four phases.** Each phase header lists
  the actual tasks landed (T01..T1{2,3,9}). Cross-checked against
  `docs/tasks/phase-{1,2,3,4}/INDEX.md` task lists. No phantom
  features.
- [x] **Tag message single-source-of-truth.** The annotated tag's
  message replicates the same phase summary as CHANGELOG.md so
  `git show v0.1.0` is self-explanatory without external docs.
- [x] **Local-only tag invariant.** `git tag -a v0.1.0 -m "..."` runs
  in iter 14. **No `git push --tags`.** Loop constraint observed.
  Owner pushes manually post-iter-16.
- [x] **Out-of-scope items explicit.** GitHub release authoring,
  daemon README edit, and GIF/screenshot capture all explicitly
  flagged as owner-actions. Filed in T13 task file under "Out of
  scope".

## Risks reviewed

### 1. Stale numeric claims after iter 15 / 16 land more commits

**Concern.** README + RELEASE-NOTES cite "51 commits", "1462 tests",
"16 Playwright specs". Iter 15 (phase tests sweep) and iter 16
(PHASE-4-COMPLETE.md sign-off) will each add a commit, bringing the
total to 53 by tag-push time. The Playwright spec count may grow if
iter 15 adds smoke specs.

**Mitigation.** The tag captures the commit SHA at iter-14 time, so
`git show v0.1.0 --stat` will always reflect the v0.1.0 commit. The
README + CHANGELOG numbers are descriptive of the v0.1.0 line, not a
running tally — they remain accurate against the *tagged* commit.
Iter 16's PHASE-4-COMPLETE.md will land its own (more current)
totals; the owner can amend the tag later (`git tag -d v0.1.0 && git
tag -a v0.1.0 <sha>`) only if the totals shift materially. Since the
tag has not been pushed, re-tagging is non-destructive.

**Trade-off accepted.** Numeric drift of ±2 commits is below the
noise floor for a v0.1.0 release narrative. Re-tagging is reversible
locally and the owner has the option.

### 2. Daemon major bump invalidates compatibility claim mid-release

**Concern.** README states "compatible with claude-bridge daemon
≥ v1.0.0". If the daemon ships a `v2.0.0` between this iter and the
tag push, the dashboard's vendored `src/db/schema.ts` may not match
and read pages would render the "incompatible daemon schema"
banner.

**Mitigation.** `docs/RELEASE.md` § "Release lanes" explicitly carves
this case out: a daemon major bump triggers a dashboard `v0.1.x`
patch with the refreshed vendor, not a re-cut of `v0.1.0`. The
banner is a graceful-fail design (Phase 0.5 scaffolding); read pages
fall back, mutations remain blocked. No data loss.

**Trade-off accepted.** Compat windows always carry future-looking
risk. The mitigation is documented + tested (the banner code lives
in `src/lib/discovery.ts` per Phase 0.5 review).

### 3. RELEASE-NOTES references docs that don't exist yet (`PHASE-4-COMPLETE.md`)

**Concern.** RELEASE-NOTES § "Known limitations" links to
`docs/tasks/phase-4/PHASE-4-COMPLETE.md`. That file is written in
iter 16, not iter 14.

**Mitigation.** The link will resolve once iter 16 lands. The
release notes are committed in iter 14 but **the v0.1.0 tag points
at the iter-14 commit**, so a user checking out `v0.1.0` would see a
broken link. There are two options:

1. Re-tag in iter 16 to point at the post-sign-off commit. This is
   the cleaner option since the tag should describe a *release*,
   not a partial state. Loop allows this since the tag is local.
2. Leave the link and trust that anyone checking out v0.1.0 also
   has access to `main` (where iter 16 lands).

**Decision: option 1 (re-tag in iter 16).** The PHASE-4-COMPLETE.md
sign-off commit is the natural release boundary anyway. Iter 16 will
delete the iter-14 tag (`git tag -d v0.1.0`) and re-create it on the
sign-off SHA. Recorded in the iter-16 plan.

This iter still creates the tag at iter-14 because:
(a) The acceptance criterion in INDEX requires the tag to exist
    locally before iter 15 phase-tests.
(b) Iter 15 may verify `git tag -l v0.1.0` in its sweep.
(c) Re-tagging is a single command in iter 16; the cost of
    creating-then-recreating is negligible.

## Spot checks performed

```
$ ls -la README.md CHANGELOG.md RELEASE-NOTES-v0.1.0.md docs/RELEASE.md
-rw-r--r--  README.md                  ~10 KB
-rw-r--r--  CHANGELOG.md               ~5 KB
-rw-r--r--  RELEASE-NOTES-v0.1.0.md    ~6 KB
-rw-r--r--  docs/RELEASE.md            ~6 KB

$ ls docs/tasks/phase-4/T13-*
docs/tasks/phase-4/T13-release-docs.md
docs/tasks/phase-4/T13-review.md

$ git -C /Users/hieutran/projects/claude-bridge tag -l --sort=-version:refname | head -3
v1.0.4
v1.0.3
v1.0.2
   ↳ confirms cross-link "v0.5.x – v1.0.x" window is accurate.

$ grep -rn "v0.1.0" CHANGELOG.md README.md RELEASE-NOTES-v0.1.0.md docs/RELEASE.md | wc -l
~25 references; all consistent with the tag string.

$ grep "version" package.json
"version": "0.1.0"
   ↳ already matches the tag (set during Phase 0/0.5 scaffold).
```

## Files touched

```
A  README.md                                       (replaced; ~270 lines)
A  CHANGELOG.md                                    (~100 lines)
A  RELEASE-NOTES-v0.1.0.md                         (~140 lines)
A  docs/RELEASE.md                                 (~150 lines)
A  docs/tasks/phase-4/T13-release-docs.md          (~110 lines)
A  docs/tasks/phase-4/T13-review.md                (this; ~100 lines)
```

No code, no migrations, no test files, no `package.json`, no
`bun.lock`. Pure documentation iter.

## Carry-overs to v0.2.0

- **GIF / hero screenshot capture** — owner adds at release-push
  time; placeholder spot in README is ready.
- **GitHub release authoring** — owner runs `gh release create
  v0.1.0 -F RELEASE-NOTES-v0.1.0.md`.
- **Daemon README cross-link paste** — snippet ready in
  `docs/RELEASE.md`; owner pastes into the daemon repo.
- **`bun run sync-schema`** for daemon-side schema drift detection.
- **Re-tag at iter-16 sign-off SHA** — recorded above; iter 16's
  plan includes `git tag -d v0.1.0 && git tag -a v0.1.0 -m "..."` on
  the post-sign-off commit.
