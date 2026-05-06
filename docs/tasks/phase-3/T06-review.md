# P3-T6 — `schedules.add` mutation + create dialog: code review

> Reviewer's pass over the T6 deliverables before commit. T6 is the
> first **mutation** in Phase 3's schedules vertical, so the full
> Phase 3 invariant checklist applies (CSRF / rate limit / audit / no
> direct table writes / privacy precedent).

## Files touched

| Path | Status | Lines |
|---|---|---|
| `src/lib/schedule-add-client.ts` | new | 273 |
| `src/components/cron-picker.tsx` | new | 272 |
| `src/components/schedule-create-dialog.tsx` | new | 463 |
| `src/server/dto.ts` | edit | +9 (`ScheduleAddResult`) |
| `src/server/routers/schedules.ts` | edit | +178 (`add` proc + helpers) |
| `app/schedules/page.tsx` | edit | +6 (mount trigger + dialog) |
| `tests/lib/schedule-add-client.test.ts` | new | 19 cases |
| `tests/server/schedules-router.test.ts` | edit | +17 cases (was T05's 11 → 28) |
| `tests/app/cron-picker.test.ts` | new | 11 cases |
| `tests/app/schedule-create-dialog.test.ts` | new | 12 cases |
| `docs/tasks/phase-3/T06-schedule-create.md` | new | task spec |
| `docs/tasks/phase-3/T06-review.md` | new | this file |

## Phase 3 invariant checklist (full — first schedule mutation)

### 1. Calls daemon MCP (no direct table writes) — ✅
- `schedules.add` invokes `ctx.mcp.call("bridge_schedule_add", ...)` via
  the Phase 2 T12 pool. No `INSERT` against the `schedules` table from
  the dashboard side.
- Daemon-response parser accepts both shapes the daemon emits (the
  on-wire `text("Schedule #N created")` envelope, plus the structured
  `{ id }` shape used by the test fake). See `extractScheduleId`.
- Missing MCP context → `INTERNAL_SERVER_ERROR` with no audit row, same
  guard as `tasks.dispatch` and `loops.start`.

### 2. CSRF guard — ✅
- POST → `csrfGuard` runs in `app/api/trpc/[trpc]/route.ts` before any
  mutation procedure. The dialog reads the `bridge_csrf_token` cookie
  via `readCsrfTokenFromCookie(document.cookie)` and forwards the value
  in the `x-csrf-token` header on every submit.
- CSRF-missing UX surfaces "session expired — reload the page". The
  dialog disables submit while csrfMissing=true; the `csrfMissing`
  branch in the view test pins this.

### 3. Rate limit — ✅
- Same 30-mutations/min/user bucket as Phase 2 — applied at the route
  handler via `rateLimitMutations`. No router-level work; this stays
  single-sourced. (No new test case here — the existing rate-limit
  route test in `tests/app/trpc-rate-limit-route.test.ts` covers the
  shared bucket; schedule.add inherits the policy automatically.)

### 4. Audit log — ✅
- `appendAudit({ ctx, action, resourceId, payload })` runs on **every
  exit path**:
  - Success → `action="schedule.add"`, `resourceId=String(id)`, payload
    `{ agentName, intervalMinutes, hasPrompt:true, name?, cronExpr?,
       hasChannelChatId? }`.
  - MCP error → `action="schedule.add.error"`, payload includes the
    `code` from `auditFailureCode(err)`.
  - Malformed daemon response → `action="schedule.add.error"`,
    `code="malformed_response"`.
  - Validation failure → no audit (zod throws BAD_REQUEST before the
    procedure body runs; same precedent as Phase 2 T01).
  - Missing MCP context → no audit (context guard runs before the
    audit envelope; same precedent as `tasks.dispatch`).
- `request_id` propagated via Phase 2 lesson §4. Asserted via the
  `request_id` UUID-shape regex in the happy-path test.

### 5. Privacy — `prompt` text NEVER echoed into audit — ✅
- Six failure-branch tests assert
  `payload_json` does not contain the literal `"private prompt text"`
  / `"secret-prompt-text"` substring. Plus the success-path test
  asserts the same against `"SECRET_PROMPT_DO_NOT_LEAK"`.
- `hasPrompt: true` sentinel surfaces on every success row instead.
- The dialog's view test (`does NOT echo the prompt text into any
  data-/aria- attribute`) catches the regression where a developer
  might accidentally bake the prompt into a hidden field. The textarea
  legitimately holds the prompt as its inner text — the user typed it.

### 6. No optimistic UI — ✅
- The mutation produces a server-side `id` we don't predict client-
  side; submit blocks on the round-trip. Success state surfaces the
  daemon-assigned `#<id>` as a one-line confirmation, then the user
  refreshes the table (no auto-refresh — see §c below).

### 7. No DangerConfirm — ✅
- Creation is not destructive. DangerConfirm lands in T7 (delete
  schedule) per INDEX Phase 3 invariant note.

## Cross-cuts I checked specifically

### a. Cron lib choice — `cron-parser` + `cronstrue` (matches T05 stack)

T05 already vendored `cron-parser` for `formatNextRun` and `cronstrue`
for the human-readable label on the list view. T06 reuses both:

- `cron-parser` for **validation** + **interval inference** (the
  "uniform delta" check).
- `cronstrue` for the **human label** rendered alongside the cron
  picker preset.

No new dep, no version bump. The choice was effectively pre-decided by
T05 and T06 just leans into it.

### b. Daemon-side gap — daemon ignores `cron_expr`

`bridge_schedule_add` (per `claude-bridge/src/mcp/tools.ts:285`) only
declares `agent_name`, `prompt`, and `interval_minutes` as required
inputs. There is **no** `cron_expr` parameter today. The dashboard
side handles this gap by:

1. Letting the user pick a cron expression (presets or custom).
2. Computing the uniform interval from the cron client-side via
   `cron-parser` — `evaluateCron` returns `null` for non-uniform
   expressions (e.g. `0 9 * * 1-5` weekdays — three 24h gaps then a
   72h weekend gap).
3. Submitting **only** `intervalMinutes` to the daemon. The
   `cronExpr` field IS forwarded as wire metadata (the future
   daemon-side cron support is plumbed) but the daemon currently
   ignores it.
4. Recording `cronExpr` in `audit_log.payload_json` (short label, not
   opaque) so the forensic trail captures the user's *intent* even
   though the daemon currently only stores `intervalMinutes`. No
   audit-shape change needed when daemon-side cron lands.

### c. Submit-disable matrix — exhaustive vs surprise

Submit is disabled when **any** of:

- agents loading (`status === "loading"`)
- no agents available (`agents.length === 0`)
- empty prompt OR oversized prompt
- empty agentName
- cron picker reports `valid=false` (cron-mode UX is the same whether
  the cron is malformed or non-uniform — both block submit)
- name/channelChatId oversized
- csrfMissing
- already-submitting

The `<ScheduleCreateDialogView>` view test pins each of these; the
view function `isFormValid` is the single decision point so any
future predicate addition slots in cleanly.

### d. Auto-refresh after success — explicitly NOT done

Earlier draft of `<ScheduleCreateDialog>` called
`useRouter().refresh()` to bring the new row into the table without
the user having to refresh manually. That broke the
`tests/app/schedules-page.test.ts` SSR tests (the dialog is mounted on
the page, and `useRouter` requires the AppRouterContext that the
plain `renderToStaticMarkup` smoke test does not provide).

Removed the auto-refresh — matches the precedent set by
`<DispatchDialog>` and `<StartLoopDialog>` (neither calls
`useRouter`). The user dismisses the success card; the next page
visit / poll picks up the new row. T7's pause/resume/delete will need
to refresh inline (the user expects the row state to flip
immediately) — that's a client island living *inside* the table row,
where the AppRouterContext is available.

### e. Optional fields — Zod's `.optional()` rejects explicit `undefined`

`buildScheduleAddRequest` builds the JSON envelope by mutating an
empty object — it inserts `name` / `cronExpr` / `channelChatId` only
when defined. Zod's `.optional()` is structurally unforgiving: an
explicit `{ name: undefined }` key fails the schema even though
"absent" passes. Same pattern as `tasks.dispatch.model` from Phase 2
T01 + `loops.start.maxIterations` from P3-T3. The
`buildScheduleAddRequest` test pins the no-key contract.

### f. Agents dropdown — independent cache, NOT shared with start-loop

`<ScheduleCreateDialog>` keeps its own `AGENTS_CACHE` constant (same
pattern as `<StartLoopDialog>`) instead of factoring a shared
`agents.cache.ts` module. Premature consolidation per Phase 2 lesson
§1 — if a fourth dialog opens we'll factor the cache module then.
Each dialog has its own `__resetXxxAgentsCache()` test-only export to
keep the existing precedent.

### g. Cron picker `now` injection — render once on mount

The interactive `<CronPicker>` captures `useMemo(() => new Date(),
[])` on mount and threads it through the `evaluateCron` calls. This
keeps the next-3 fire-time preview stable across keystrokes (otherwise
each keystroke would re-evaluate against a slightly later "now" and
the preview would jitter as the user types). For tests, the picker's
`now?: Date` prop is honoured directly — same shape as
`formatNextRun`'s injection point in T05.

If a user leaves the dialog open for hours, the preview drifts — the
test fires at "now of N hours ago" rather than "now". Acceptable for a
creation flow; if it ever becomes a complaint, a `useEffect` poll
re-evaluating every 60s would close the gap.

### h. `<ScheduleCreateTrigger>` — open-state via custom event

Same pattern as `<StartLoopTrigger>` and `<DispatchTrigger>`: the
trigger button dispatches a `bridge:open-schedule-create` custom
event; the dialog wrapper listens for it. Decouples the trigger from
the dialog component (the trigger can live in a server-rendered
header while the dialog mounts elsewhere). Manual page test verified
by T05's existing `/schedules` smoke test (mounting the dialog
doesn't break the empty-state copy).

## Test surface

| Suite | Cases | Coverage |
|---|---|---|
| `tests/lib/schedule-add-client.test.ts` | 19 | `CRON_PRESETS` invariants (intervalMinutes matches cron expression); `evaluateCron` (preset + every-15min + non-uniform reject + parse error + empty + whitespace trim); `cronToIntervalMinutes` convenience; `buildScheduleAddRequest` envelope shape (required-only / optional-included / channelChatId); `parseTrpcResponse` (un-transformed + json-wrapped + error envelope + missing-code fallback). |
| `tests/server/schedules-router.test.ts` (extended) | +17 | happy paths (text envelope + structured fake + channelChatId sentinel + unauth user_id omit); input validation across every field (empty/oversized prompt + empty agent + interval 0/43_201 + oversized cron); malformed daemon response (no id; text without "Schedule #N created"); MCP error mapping (every `McpPoolError` code); missing MCP context. **Privacy invariant pinned on success + every error branch.** |
| `tests/app/cron-picker.test.ts` | 11 | preset radio rendering; preset-checked exclusivity; custom mode renders raw input; invalid cron → red border + parse-error message; non-uniform cron → amber border + warning; valid → cronstrue label + 3 fire times; preset switch flips checked radio; no eval-message on `ok`; no next-fires on invalid; humanLabel=null hides label; preset mode hides the custom input. |
| `tests/app/schedule-create-dialog.test.ts` | 12 | open=false → invisible; loading state; full form on idle; submit-disabled matrix (loading / submitting / empty prompt / invalid cron / no agents / csrfMissing); success state surfaces `#id`; error state preserves form values + re-enables submit; no agents → hint copy; **prompt never echoes into data-/aria- attribute**. |

**59 new test cases total** (47 + 12 from the dialog view tests we added).

`bun run test` (canonical): **817 pass / 0 fail / 4052 expect calls**.

`bun run build`: clean. `/schedules` route grew from 171 B (T05
read-only) → **40.9 kB First Load JS** — the cron picker pulls in
`cron-parser` + `cronstrue` runtime. Acceptable: the dialog is the
primary interaction on the page; the libs would be shared with T7+
schedule-edit / cost-forecast (T9) when those land.

## Lessons / call-outs for next iters

1. **`cron-parser` + `cronstrue` add ~40 kB of First-Load JS.** That's
   the entire schedules page's client-island weight today. T7
   (pause/resume/delete) shouldn't add another runtime parser; T8
   (run-history drawer) and T9 (cost forecast) should reuse the
   already-shipped libs rather than introduce alternatives.

2. **The `cronExpr` audit field captures user intent, but the daemon
   ignores it on the wire.** When the daemon grows native cron
   support, only `extractScheduleId` and the MCP params builder need
   to learn the new field — the audit shape stays unchanged. A
   one-line edit on the dashboard side; no migration.

3. **`<ScheduleCreateDialog>` does not auto-refresh on success.** The
   user dismisses the card and the next page poll / navigation picks
   up the new row. T7 inline action menus (pause/resume/delete) need
   `router.refresh()` from a client island living *inside* the table
   row — not at the dialog level — so they don't break the page-level
   SSR test.

4. **The submit-disable matrix is fully testable from the view layer.**
   Future predicates (e.g. T9's cost-forecast warning gate) should
   slot into the same `isFormValid()` decision point + a new view-test
   case rather than being inlined into the submit handler.

## Verdict

✅ Ready to commit as `feat(phase-3): T06 schedule create form + cron picker`.
