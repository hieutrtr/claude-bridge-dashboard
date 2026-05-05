# P1-T11 — Empty / error / loading states — Self-Review

> Spec: `T11-empty-error-loading.md`. Iter 12/17.

## Files changed / added

**New:**
- `src/lib/bridge-error.ts` — `isBridgeNotInstalledError()` predicate
  + `BRIDGE_NOT_INSTALLED_NAME` constant. Name-based discriminator
  so the predicate survives the server→client RSC error
  serialization (which strips the prototype).
- `src/components/ui/skeleton.tsx` — `<Skeleton>` shadcn-flavored
  primitive. `role="status" aria-busy="true"` for accessibility +
  the `animate-pulse` Tailwind utility for the visual cue.
- `src/components/offline-banner.tsx` — `<OfflineBanner home,
  configPath?>` server component. Card-shaped block with the
  "Daemon offline" heading, the configured config-home path, and
  the `bridge install` remediation copy. No client interactivity —
  the retry control lives in the boundary that wraps it.
- `app/error.tsx` — root error boundary. `"use client"`, default
  export `RootError({ error, reset })`. Branches via
  `isBridgeNotInstalledError(error)` to render `<OfflineBanner>`;
  otherwise a generic fallback (heading + `<pre>` of the message
  + optional digest). Both branches expose a `<button>` wired to
  `reset()`.
- `app/loading.tsx` — root loading skeleton (heading bar + 6 card
  squares).
- `app/agents/loading.tsx` — `/agents`-shaped skeleton (heading +
  8 grid placeholders matching `<AgentsGrid>`'s 4-up xl layout).
- `app/tasks/loading.tsx` — `/tasks`-shaped skeleton (heading +
  description + filter strip + 8 row strips).
- `app/cost/loading.tsx` — `/cost`-shaped skeleton (heading + 3
  KPI cards + a tall chart placeholder).
- `tests/lib/bridge-error.test.ts` — 7 tests covering the
  predicate against a real instance, the wire-shape plain object,
  generic Error, renamed Error, primitives, missing-name objects,
  and the exported constant.
- `tests/app/error-boundary.test.ts` — 5 tests: `"use client"`
  pragma at byte 0, default-export type, offline branch markup
  with `bridge install` + the home path + a retry button, generic
  branch markup with the error message + retry button + no offline
  copy bleed-through, and the read-only invariant
  (no POST/PUT/PATCH/DELETE handlers).
- `tests/app/loading-states.test.ts` — 12 tests (3 × 4 routes):
  file existence, default-export type, and `animate-pulse`
  presence on every route's loading skeleton.
- `tests/app/offline-banner.test.ts` — 4 tests: home path
  rendering, explicit `configPath` rendering, remediation copy,
  heading.
- `docs/tasks/phase-1/T11-empty-error-loading.md` — task spec.
- `docs/tasks/phase-1/T11-review.md` — this file.

**Modified:**
- `docs/tasks/phase-1/INDEX.md` — checkbox + status line.

**Unchanged (re-verified):** `<AgentsGrid>` empty state,
`<TaskTable>` (T04) empty state, `<GlobalTaskTable>` (T05)
filtered/unfiltered empty states, `<MemorySection>` (T10) empty
state, `<TaskDetail>` result + transcript empty branches (T06/T07),
`/cost` page empty state (T09). T11 does not regress them — the
loading skeletons sit one layer up; the empty branches still fire
when the data resolves to zero rows.

## Self-review checklist

- [x] **Tests cover happy + edge cases** — happy: real
  `BridgeNotInstalledError` instance routes to the banner; offline
  banner renders home + configPath + remediation; root loading +
  three per-route loadings each render `animate-pulse`. Edge: the
  serialized `{ name: "BridgeNotInstalledError" }` plain-object
  shape (cross-boundary case); generic `Error` falls through to
  the generic branch and the offline copy MUST NOT bleed in;
  primitives (`null`, `undefined`, `"string"`, `42`, `true`) all
  return `false`; missing-name object returns `false`; renamed
  `Error` (e.g. `name === "TypeError"`) returns `false`. Read-only
  invariant tested directly on `app/error.tsx`.
- [x] **Not over-engineered** —
  - One predicate (`isBridgeNotInstalledError`) — no error class
    hierarchy, no factory.
  - One Skeleton primitive — single Tailwind class, no variants.
  - Single root error boundary; per-segment boundaries explicitly
    deferred (Phase 2 polish).
  - The error boundary parses the error message with two regexes
    rather than serializing extra structured fields. The discovery
    error already encodes both the home and configPath in its
    message — re-using them avoids changing the error class
    contract just for the UI consumer.
  - `<OfflineBanner>` is a pure server component — no useState, no
    useEffect, no client bundle.
- [x] **ARCHITECTURE v2 picks honoured** —
  - Next.js App Router conventions: `app/error.tsx` as a client
    component with the canonical `{ error, reset }` props;
    `loading.tsx` as a server component for Suspense fallback.
  - shadcn Card primitives + Tailwind v4 design tokens
    (`hsl(var(--border))`, `hsl(var(--muted))`,
    `hsl(var(--muted-foreground))`).
  - No new heavy dep introduced — the boundary uses only the
    existing card/skeleton primitives plus inline button styling.
  - tRPC/DB layer untouched — read-only invariant preserved
    automatically.
- [x] **No secret leak** — the offline banner surfaces only the
  user's own `$CLAUDE_BRIDGE_HOME` path (already exposed via the
  config file the user owns). The generic fallback echoes the
  error message into a `<pre>` — that's intentional for debug, but
  the message is whatever a thrown Error carries (no env, no JWT,
  no DB rows). No tokens, no cookies, no schema secrets.
- [x] **Read-only: NO mutation/dispatch call** —
  - `app/error.tsx`: zero tRPC calls, zero DB queries, zero
    `fetch` calls. `reset()` is React's boundary reset.
  - `app/loading.tsx` + `app/{agents,tasks,cost}/loading.tsx`: pure
    skeleton placeholders. No data fetches.
  - `<OfflineBanner>`: pure presentational. No side effects.
  - `<Skeleton>`: pure presentational.
  - `src/lib/bridge-error.ts`: predicate only — no I/O, no DB.
  - The read-only invariant guard test in
    `tests/app/error-boundary.test.ts` (no POST/PUT/PATCH/DELETE
    exports) pins the boundary against a future PR sneaking in a
    Server Action.

## Acceptance bullets vs spec

1. ✅ Root + per-route loading skeletons render `animate-pulse`
   placeholders. (`tests/app/loading-states.test.ts` verifies file
   existence, default-export, and the skeleton signature on
   `/`, `/agents`, `/tasks`, `/cost`.)
2. ✅ Root `app/error.tsx` is a client component with the
   `"use client"` pragma at byte 0; default-exports
   `RootError({ error, reset })`; branches on
   `isBridgeNotInstalledError(error)` and renders the offline
   banner with `bridge install` + the home path + a retry button.
   Generic branch surfaces the message + retry. The retry buttons
   are real `<button>` elements wired to `reset()`. (Verified by
   `tests/app/error-boundary.test.ts`.)
3. ✅ `src/lib/bridge-error.ts` exports
   `isBridgeNotInstalledError(err)` and the
   `BRIDGE_NOT_INSTALLED_NAME` constant. The predicate is name-
   based so it survives RSC error serialization. (Verified by
   `tests/lib/bridge-error.test.ts`.)
4. ✅ `<OfflineBanner home, configPath?>` renders Card + heading +
   home + `bridge install` copy. (Verified by
   `tests/app/offline-banner.test.ts`.)
5. ✅ `<Skeleton>` is reusable, takes a `className`, renders the
   `animate-pulse` token, and has `role="status" aria-busy="true"`.
   (Implicitly verified — every loading test asserts the token
   appears.)
6. ✅ Empty states audited on every Phase 1 route — see "Empty
   state audit" below.
7. ✅ `bun test`: 195 → 223 (+28 new). All green.
8. ✅ `bun run typecheck` clean.

## Empty state audit

Each Phase 1 route has a 0-row empty branch already shipped by an
earlier task. T11 reverifies they all reference a CLI remediation
or an actionable next step:

| Route | Component | Empty copy |
|-------|-----------|------------|
| `/agents` | `<AgentsGrid>` (T03) | "No agents yet. Use `bridge_create_agent` from the MCP host or `bridge agent create` on the CLI to register one." |
| `/agents/[name]?tab=tasks` | `<TaskTable>` (T04) | "No tasks for this agent yet" with a CLI hint. |
| `/agents/[name]?tab=memory` | `<MemorySection>` (T10) | "No memory recorded for this agent yet" with the on-disk path. |
| `/agents/[name]?tab=cost` | `<CostTabPlaceholder>` (T10) | Phase 2 stub pointing at `/cost`. |
| `/tasks` | `<GlobalTaskTable>` (T05) | "No tasks dispatched yet. Use `bridge_dispatch` …" or "No tasks match the current filters" when filtered. |
| `/tasks/[id]` | `<ResultSection>` + `<TranscriptSection>` (T06/T07) | "No result yet" + "No transcript on disk" / "The session JSONL has no parseable turns yet". |
| `/cost` | inline (T09) | "No completed tasks yet — run a task with `bridge dispatch` …" |
| `/loops` | stub | "Goal-loop list lands in Phase 2" — Phase 3 surface (P3-T1). |
| `/schedules` | stub | "Recurring schedule list lands in Phase 2" — Phase 3 surface (P3-T5). |
| `/login` | inline | "Auth is not configured" copy when env not set. |

## Issues found / decisions

- **Name-based discrimination over `instanceof`.** Next.js
  serializes errors thrown in a server component as plain objects
  by the time they reach the `app/error.tsx` boundary. The
  prototype is stripped, so `error instanceof BridgeNotInstalledError`
  returns `false`. The name field survives. We pin this in the
  test suite by deliberately *not* using
  `BridgeNotInstalledError` in the offline-render test — we
  fabricate `Object.assign(new Error(msg), { name:
  "BridgeNotInstalledError" })` to mirror the wire shape.
- **Message parsing in `app/error.tsx`.** I extract `home` and
  `configPath` from the error message using two regexes. Cleaner
  than re-typing the discovery error class to expose them as
  client-visible structured fields, and the discovery error's
  message format is already a stable contract (T0 / discovery.ts
  test pins the `bridge install` + home substring). If the message
  format changes, the regex falls through to the home default
  (`"~/.claude-bridge"`) — the banner still renders correctly,
  just with a less specific path.
- **No per-segment error boundaries.** The root boundary catches
  every server-component throw in Phase 1; tighter blast radius
  is Phase 2 polish. Documented in the spec's *Out of scope*
  section.
- **Discovery wiring deferred.** Current Phase 1 pages do **not**
  call `discoverBridgeDaemon()` — every page reads `bridge.db`
  directly via `getDb()`. So in practice the offline banner only
  fires when a future page (Phase 2 surfaces using socket / MCP
  endpoint) delegates to discovery and re-throws. Shipping the
  boundary now means Phase 2 doesn't need to revisit T11.
- **Skeleton flash on fast machines.** Next.js renders
  `loading.tsx` for at least one render tick even when the page
  resolves in under 50 ms. Acceptable for Phase 1; if it becomes
  noticeable in real-world usage, T12 / Phase 2 can introduce a
  Suspense delay or a min-height transition.
- **`app/error.tsx` invocation in tests.** I call
  `mod.default({ error, reset })` directly — that's a synchronous
  React element factory call (the function returns JSX, not a
  promise), so `renderToStaticMarkup` accepts it. This matches the
  pattern the existing `tests/app/cost-page.test.ts` and
  `tests/app/agent-detail-memory.test.ts` already use for server
  pages, except those are async; `error.tsx` is synchronous since
  it's a client component.
- **No use of `Error` instanceof in the predicate.** The predicate
  accepts a plain `unknown` and reads only `.name`. This means
  it will return `true` for any object with `name ===
  "BridgeNotInstalledError"` even if it's not a real Error. That's
  intentional — the wire-shape case requires it. The risk of a
  false positive (some non-error library object happens to have
  that exact name) is negligible.
- **Loops/Schedules pages.** They're Phase 3 surfaces, kept as
  Phase 2 placeholders by design. The empty audit table above
  records their copy as-is rather than upgrading them in T11.

## Test summary

```
$ bun test
 223 pass
   0 fail
 644 expect() calls
Ran 223 tests across 22 files. [799 ms]
```

Up from 195 → 223 (+28 new): 7 in `tests/lib/bridge-error.test.ts`,
5 in `tests/app/error-boundary.test.ts`, 12 in
`tests/app/loading-states.test.ts` (3 × 4 routes), 4 in
`tests/app/offline-banner.test.ts`.

`bun run typecheck` clean.

## Manual browser verification checklist (PHASE-BROWSER-TEST)

- [ ] Stop the daemon (or set `CLAUDE_BRIDGE_HOME=/nonexistent/path`)
      and visit `/agents`. Expected: the offline banner renders
      with the configured home path, the `bridge install`
      remediation copy, and a "Try again" button. Clicking the
      button re-runs the page render — same banner reappears as
      long as the config is missing.
- [ ] Throw a generic `Error` from a page (e.g. add `throw new
      Error("test")` to `app/agents/page.tsx` temporarily). Expect:
      the generic fallback renders with the message in `<pre>` and
      a "Try again" button. Removing the throw + clicking "Try
      again" recovers the page.
- [ ] Navigate to `/agents` on a slow connection (`Network →
      Throttling: Slow 3G` in DevTools). Expect: the agents grid
      skeleton with 8 placeholders renders for ~1 s before the
      real grid replaces it. No layout jump.
- [ ] Same for `/tasks` (header + filter strip + row strips
      placeholder) and `/cost` (3 KPI placeholders + tall chart
      placeholder).
- [ ] Empty state on `/agents` when DB has zero agents: copy
      "Use `bridge_create_agent` …" appears.
- [ ] Empty state on `/tasks` when DB has zero tasks: copy
      "Use `bridge_dispatch` …" appears.
- [ ] Empty state on `/cost` when no completed tasks: KPI cards
      show "$0.00" / "0" / "$0.00" + the empty-state hint replaces
      the charts.
- [ ] No `<script>` injection inside the error message `<pre>` —
      the React renderer escapes children automatically.
