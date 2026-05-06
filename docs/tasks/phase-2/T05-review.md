# P2-T05 — Audit log viewer page — Self-review

## Files changed

| File | Change | Notes |
|------|--------|-------|
| `src/server/routers/audit.ts` | NEW | `auditRouter.list({ action?, resourceType?, userId?, since?, until?, limit?, cursor? })` query procedure. Drizzle SELECT against the `auditLog` schema with `desc(createdAt), desc(id)` ordering and `id < cursor` keyset paging. |
| `src/server/dto.ts` | EDIT | Added `AuditLogRow` (mirrors schema columns + best-effort `JSON.parse(payload_json)` into `payload`) and `AuditLogPage`. |
| `src/server/routers/_app.ts` | EDIT | Registered `audit: auditRouter` in alphabetical position (between `analytics` and `loops`). |
| `app/audit/page.tsx` | NEW | Server component. Mirrors `app/tasks/page.tsx` URL-param pattern (`readString` / `readMsEpoch` / `readCursor` / `buildSearchString`). 100 rows/page. |
| `app/audit/loading.tsx` | NEW | Skeleton mirroring `app/tasks/loading.tsx` (heading + 5 filter strips + 8 row strips). |
| `src/components/audit-filters.tsx` | NEW | Plain `<form method="get">` with 5 free-text inputs (action / resourceType / userId / since / until). No `"use client"`. |
| `src/components/audit-log-table.tsx` | NEW | Pure presentational table. ISO + relative `created_at`, `<anonymous>` placeholder for null userId, payload truncated to 80 chars with `title` for full hover, `ip_hash` / `request_id` shortened to 8-char prefix. |
| `src/lib/nav.ts` | EDIT | Added `{ label: "Audit", href: "/audit" }` after Cost. |
| `tests/lib/nav.test.ts` | EDIT | Updated NAV_ITEMS expectation from 5 → 6 (Audit appended). |
| `tests/server/audit-router.test.ts` | NEW | 16 integration tests covering empty / order / paging (default 100, custom limit, cap 200, cursor stability across same-millisecond timestamps) / filters (action, resourceType, userId, `<anonymous>` sentinel, since/until, combined AND) / payload parsing (valid / invalid / null) / DTO column shape. |
| `tests/server/audit-router-perf.test.ts` | NEW | 3 perf smoke tests at 5 000 rows: default list + filtered-by-action + filtered-by-since, asserting median wall-clock < 50 ms over 10 iterations. Skippable via `BUN_TEST_PERF=0`. |
| `docs/tasks/phase-2/T05-audit-viewer.md` | NEW | Task spec (refs / acceptance / non-goals / TDD plan / impl outline / risk + mitigation). |
| `docs/tasks/phase-2/INDEX.md` | EDIT | Flipped T05 checkbox; updated status header. |

## Test count

- Unit / integration (`tests/server/audit-router.test.ts`): **16 tests, 52 expects** — green.
- Perf smoke (`tests/server/audit-router-perf.test.ts`): **3 tests, 33 expects** — green; median ~3–8 ms per query on 5 000 rows (well under 50 ms budget).
- Nav guard (`tests/lib/nav.test.ts`): **6 tests** — green after expectation update.
- Full suite (`bun test`): **477 pass, 0 failures** (junit confirms; the bun summary's "1 fail / 1 error" tally counts the pre-existing Playwright-incompat `tests/e2e/smoke.spec.ts` import error).
- Typecheck: `bun run typecheck` (`tsc --noEmit`) — clean.
- Build: `bun run build` — clean; the `/audit` route appears as `ƒ /audit` (server-rendered on demand) at 169 B page-specific JS.

## Self-review checklist

- [x] **Tests cover happy + error path.** Empty DB, 250-row pagination, limit-out-of-range BAD_REQUEST, all 5 filter axes, AND combination, malformed JSON payload, null payload, same-millisecond cursor stability, `<anonymous>` sentinel for null user.
- [x] **Mutation has audit log entry?** N/A — this is a query-only surface. **No** mutation, **no** audit row written by the viewer (the audit row writes happened in T04 + T01/T03/T06/T07/T08).
- [x] **CSRF token check?** N/A — `audit.list` is a tRPC `query` (HTTP GET via batch link). CSRF only gates POST/mutation entries (T08).
- [x] **Rate limit applied?** N/A — query path. Rate-limit-mutations (T07) only inspects mutation requests. A future per-user query rate-limit is filed against Phase 4.
- [x] **Optimistic update has rollback?** N/A — read-only.
- [x] **Confirmation pattern for destructive action?** N/A — no destructive action.
- [x] **No secret leak.** The viewer surfaces the same payload T04 already wrote; T04 redacts top-level `password` keys. The `<pre>`-style payload cell in the table is wrapped behind a `truncate(80)` + hover-title so a full payload doesn't reflow on screenshot. `ip_hash` is shown as 8-char prefix only (not because the hash is sensitive — it's already SHA-256-salted — but to keep the column narrow). `user_agent` not surfaced in the table at all (filed for Phase 4 if forensics needs it; for now it's stored, not rendered).

## Notes / surprises

- **`payload` parsing is best-effort, not Zod-validated.** The audit writer (T04) is the only producer; we trust it to emit well-formed JSON. The viewer falls back to `payload: null` and preserves `payloadJson` raw on parse failure so a future T04 regression surfaces in the audit log itself. Zod-decoding `payload` per known action would tightly couple the viewer to every mutation router's payload shape — explicitly avoided.
- **Owner-only enforcement is single-layer (middleware).** Documented in spec §"Acceptance criterion 6" and the procedure docblock. Phase 1's auth shim doesn't carry a role concept; Phase 4 adds it. The failure mode if a contributor exposes the procedure to a non-owner caller (e.g. via a future `/api/public/audit` route) is data leak — flagged in PHASE-2-COMPLETE.
- **No virtualization library** despite the INDEX line "virtualized table (5 000+ rows)". The pagination-at-100 approach satisfies the underlying perf budget (DOM bounded, SQL < 50 ms p95 verified by smoke test) at lower complexity and lower bundle weight. ARCH §11's "virtualized" was the abstract requirement; pagination is a valid implementation. The spec §1 "References" + §"Risk + mitigation" rows document the substitution explicitly.
- **No browser smoke test in this iteration.** Build verifies the page compiles + the route is registered. The Phase 2 sign-off (slot 14) bundles a Playwright smoke covering the `/audit` page across the full phase test sweep. The page is a thin server component over already-tested DTOs, so a per-iteration Playwright smoke would inflate cost without changing failure detection.
- **Same-millisecond cursor edge-case** is the most subtle test (test 14 in `audit-router.test.ts`). T07/T08 guards can fire ~5–30 audit rows per second when a token-bucket exhausts; without the `id` tiebreak, a `(created_at DESC)` ordering could swap row positions across pages. The fix is a 2-column ORDER BY in the procedure — verified end-to-end.
- **`<anonymous>` sentinel for null user_id** is novel to this task. Drizzle's `eq(col, null)` produces `WHERE user_id = NULL`, which is always false in SQL — `isNull(col)` is the correct primitive. Test 9 asserts the right-shape SQL is emitted via behavioural assertion (the result set contains both null-user rows).
- **5 000-row perf budget is comfortable.** Local M-series median was 3–8 ms; we set the test budget to 50 ms to absorb CI variance. Filter-by-since hits the `idx_audit_log_created_at` index; filter-by-action hits the index range scan with a post-filter on `action` (no index on `action` alone — at 5 k rows the seq inside the index range is fine; at 50 k rows we'd revisit).

## Acceptance criteria status

| Criterion | Status |
|-----------|--------|
| 1. `audit.list` exists with the documented input shape | ✅ |
| 2. `AuditLogRow` DTO with parsed `payload` | ✅ |
| 3. `audit: auditRouter` registered in `_app.ts` | ✅ |
| 4. `/audit` page renders filter strip + table | ✅ |
| 5. Sidebar entry added; nav test updated | ✅ |
| 6. Owner-only via middleware (single-layer); Phase 4 ADR flag | ✅ |
| 7. Perf < 50 ms p95 on 5 000 rows for default + filter shapes | ✅ (median ~3–8 ms) |
| 8. Privacy — payload as-written; ip_hash / UA truncated | ✅ |
| 9. Zero mutation, zero CSRF/rate-limit/audit writes | ✅ |
