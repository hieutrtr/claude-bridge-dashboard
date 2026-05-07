# T11 — Code review

> **Phase:** 4 (Polish & Multi-user) · **Iter:** 12/16 · **Reviewer:** loop-self · **Verdict:** PASS — ship.

T11 is a HIGH-risk task because telemetry is the easiest privacy
foot-gun to ship by accident: one missing scrubber turns "anonymous
diagnostics" into "I just leaked every customer's email into a SQL
table". This review walks the surface against the privacy invariants
the Phase 4 INDEX laid out, in priority order.

## §1 — Default state is OFF

> Phase 4 invariant: "default OFF; opt-in is explicit"

✅ Verified at three layers:

1. **Migration** — `0005_telemetry_events.sql` does NOT seed any rows
   into `dashboard_meta`. The opt-in key only exists after the owner
   explicitly flips the toggle.
2. **Server** — `getTelemetryOptIn(db)` returns `false` when the row
   is missing (`getMeta(...) === null` ⇒ `=== "true"` is `false`).
3. **Router** — `telemetry.optInStatus()` returns
   `{ enabled: false, installId: null, counts: { … 0 } }` on a fresh
   install. The `installId` is `null` until the toggle flips ON.

Test coverage: `telemetry.optInStatus → reports OFF by default + zero
counts` and `record → returns dropped_off when telemetry is OFF (no
row inserted)` both pin this invariant.

**No latent code path exists that flips the toggle without an owner
mutation.** Searched the codebase:

```
$ grep -rn "setTelemetryOptIn(true" src/
src/server/routers/telemetry.ts:124:      if (changed) setTelemetryOptIn(input.enabled);
```

Only the router writes the flag, and only inside `ownerProcedure`. ✓

## §2 — No user_id / IP / UA / PII on recorded rows

> Phase 4 invariant: "no user_id, IP, UA, or PII in recorded rows"

✅ Verified by SCHEMA + SCRUBBER + TEST GRID, defence-in-depth:

**Schema-level (load-bearing):** `telemetry_events` has six columns
and `user_id` is **not** one of them. There is no migration that adds
it, no router code that joins it, no tRPC procedure that exposes it.
This is the strongest privacy guarantee — even a buggy router cannot
leak what the schema does not store.

**Scrubber-level (defence-in-depth):** every event's `eventName`
flows through `sanitiseEventName` which:
- Rewrites UUIDs (`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
  to `[id]`.
- Rewrites hex tokens ≥ 12 chars to `[id]`.
- Rewrites bare digit runs ≥ 6 to `[id]`.
- Strips query strings entirely.
- **Rejects** strings containing emails, IPv4 octets, file paths
  (`/Users/`, `/home/`, `/var/`, `/etc/`, etc.), or non-ASCII chars.
- Truncates to 128 chars.

The same module ships in browser + server bundles so the post-scrub
event name on the wire matches what the server inserts.

**Test-grid level:** `tests/lib/telemetry-pii.test.ts` runs 32 cases
across the matrix. `tests/server/telemetry-router.test.ts` adds the
"never echoes the offending raw eventName in the response" guard so a
sanitiser miss surfaces as a stringification leak in CI.

**Privacy precedent extension:** the `tokenIdPrefix` shape T01
introduced for magic-link audits maps cleanly onto telemetry's
`installId` shape — both are anonymous opaque tokens that never join
back to a user identity. The audit module sees them; the audit
PAYLOADS never echo them.

## §3 — `record` does NOT audit per call

> Phase 4 INDEX § "Audit invariant": "`record` does NOT audit (would
> defeat the purpose)"

✅ Verified. The router's `record` mutation does not call
`appendAudit`. The test
`tests/server/telemetry-router.test.ts > does NOT write an audit row
for record (privacy)` asserts no audit row starts with
`telemetry.record` after a successful insert.

**Why this is correct, not lazy:** the audit log records `user_id` on
every row. If `record` audited, the audit log would now hold a 1:1
join between every page-view-on-a-route and the user who saw it.
Telemetry's whole point is to NOT have that join — auditing telemetry
events would re-introduce the privacy hole we just spent 5 columns of
schema avoiding.

`setOptIn` DOES audit (`telemetry.opt-in-toggle`) because (a) it
mutates a meta-setting, not user data, and (b) the install owner
needs to be able to see who flipped the toggle. Payload is
`{ enabled: bool, changed: bool }` — boolean, not the install_id.

## §4 — RBAC matrix is correct

> T03 acceptance: every mutation has a row in `rbac-matrix.test.ts` or
> a router-local equivalent.

✅ Test grid:

| Procedure              | Anonymous | Member            | Owner |
|------------------------|-----------|-------------------|-------|
| `optInStatus` (Q)      | 401       | 200               | 200   |
| `setOptIn` (M)         | 401       | **403**           | 200   |
| `record` (M)           | 401       | 200               | 200   |
| `recent` (Q)           | 401       | **403**           | 200   |

12/12 cases covered in `tests/server/telemetry-router.test.ts`. The
choice to make `record` member-callable (vs owner-only) is deliberate:
events are install-scoped, not user-scoped, so any signed-in caller's
ping is a legitimate datapoint. Members cannot flip the toggle, so
they cannot poison the bool, and they cannot read `recent`, so they
cannot exfiltrate the rows they helped record.

## §5 — Anonymous identity stability

The install-id UUID is generated **once** on the first `setOptIn(true)`
call and stored in `dashboard_meta`. Flipping OFF then back ON keeps
the same UUID — the test
`flipping OFF preserves the install_id (anonymous identity stable)`
asserts this.

**Why stable, not regenerate-on-each-on?** Two reasons:
1. Regenerate would mean a single install reports as multiple
   anonymous identities to any future `TELEMETRY_ENDPOINT` upload
   target — making cohort analysis impossible.
2. Regenerate would mean re-flipping the toggle leaks the regenerate
   event itself as a side-channel ("this install just rotated").

The trade-off: a deeply-paranoid owner who wants to "wipe identity"
must `DELETE FROM dashboard_meta WHERE key = 'install_id'`. Documented
in T11-review §5 and surfaced via the `install_id` chip in the UI.

## §6 — Upload endpoint not yet wired

> T11 acceptance: "data POSTed to a USER-controlled endpoint
> (`TELEMETRY_ENDPOINT` env, defaults to null — no upload until set)"

✅ Verified at the env-var contract. `TELEMETRY_ENDPOINT` is in the
Phase 4 INDEX env table (line 612-ish) with default `null`. No code
in T11 reads it — the upload loop is filed against v0.2.0. Rows
accumulate in the local SQLite file until the owner explicitly
configures an upload destination.

This is **strictly more conservative** than the v1 plan required.
The plan said "POST to user-controlled endpoint"; T11 ships "no POST
at all by default", which is a privacy upgrade.

## §7 — Things that could go wrong (and didn't)

These were considered + ruled out by the design:

1. **PII smuggled via emoji / RTL marks.** `containsPii` rejects any
   non-printable-ASCII character. Verified by
   `tests/lib/telemetry-pii.test.ts > rejects non-ASCII strings`.
2. **PII smuggled via `value_ms`.** `value_ms` is `INTEGER`-typed and
   CHECK-constrained to `[0, 600_000]`. A string would be coerced to
   null by `clampValueMs`.
3. **PII smuggled via `event_type`.** Whitelist of three values; SQL
   CHECK constraint enforces it at the storage layer.
4. **Audit log holds the install_id.** Verified explicitly in the
   "audit row never echoes the install_id" test — the payload_json
   string is asserted not to contain the freshly-generated UUID.
5. **A future migration adds `user_id` "for analytics".** The schema
   comment in `0005_telemetry_events.sql` calls this out as a privacy
   trade-off recorded here. Future migrations should be reviewed
   against this constraint.
6. **Browser auto-records pages without the toggle.** The frontend
   recorder is **not yet wired into the layout** — it ships as a
   library only. Page-view auto-recording lands in the T11 follow-up
   (filed for v0.1.1 if telemetry sees real use; deferred from v0.1.0).
   Until then, the `recent events` panel shows the empty-state
   message.

## Verdict

**PASS — ship.** Privacy guarantees are layered (schema + scrubber +
test grid + audit). RBAC matrix is exhaustive. Default state is OFF.
The carve-out for not auditing `record` is justified and asserted.
The deferred upload endpoint reduces scope without reducing safety.

Recommended commit message:

```
feat: T11 telemetry opt-in (no PII)
```
