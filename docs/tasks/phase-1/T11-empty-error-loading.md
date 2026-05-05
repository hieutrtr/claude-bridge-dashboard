# P1-T11 — Empty / error / loading states

> Iter 12/17. Spec for the missing UX polish on every Phase 1 route.

## Reference

- v1 ARCH §11 *Performance Budgets* — FCP < 200 ms ⇒ skeletons must
  render before the tRPC `createCaller` round-trip resolves.
- v2 ARCH §7.2 *Discovery Protocol* — `discoverBridgeDaemon()` throws
  `BridgeNotInstalledError` when `~/.claude-bridge/config.json` is
  missing. The dashboard must present that as a "Daemon offline"
  banner with the config path + the remediation command, **not** as a
  blank page or a generic stack trace.
- v1 IMPLEMENTATION-PLAN P1-T11 acceptance: "ngắt mạng DB → error
  boundary; 0 agent → 'Tạo agent đầu tiên via CLI'".
- v2 P1-T15 (offline banner UI) is rolled into this task per the INDEX
  *Notes* section.
- Next.js App Router conventions: `app/loading.tsx` is rendered while a
  server component awaits async data; `app/error.tsx` (client
  component, default export takes `{ error, reset }`) wraps the
  segment in a React error boundary.

## Acceptance criteria

1. Root `app/loading.tsx` renders a skeleton placeholder while the
   server component is fetching. Per-route loading files exist for
   `/agents`, `/tasks`, `/cost` so the skeleton tracks each page's
   layout shape (page heading + grid / table / charts).
2. Root `app/error.tsx` is a client component (`"use client"`). It:
   - Receives `{ error, reset }` per Next.js contract.
   - Detects `BridgeNotInstalledError` (by `error.name ===
     "BridgeNotInstalledError"` to survive serialization across the
     server/client boundary) and renders a dedicated "Daemon offline"
     banner with the configured `$CLAUDE_BRIDGE_HOME` path + the
     `bridge install` remediation copy, plus a "Try again" button
     wired to `reset()`.
   - Renders a generic error fallback otherwise — message + a "Retry"
     button calling `reset()`.
3. A new `src/lib/bridge-error.ts` exports
   `isBridgeNotInstalledError(err: unknown): boolean` — centralizes
   the name-based discriminator so the error boundary, future surface
   pages, and tests share the same predicate.
4. A new `<OfflineBanner>` server component
   (`src/components/offline-banner.tsx`) encapsulates the offline
   copy and is reused by `app/error.tsx`. Renders a Card-shaped
   block with a heading, the configured config path, and the
   remediation command — no client interactivity.
5. A reusable `<Skeleton>` primitive
   (`src/components/ui/skeleton.tsx`) — a div with the shadcn
   `animate-pulse` token. Used by every `loading.tsx`.
6. Empty states on every Phase 1 route exist and reference the CLI
   remediation:
   - `/agents` empty → "No agents yet. Use `bridge agent create` …"
     (already shipped by T03; reverified).
   - `/tasks` empty → "No tasks dispatched yet. Use `bridge dispatch`
     …" or "No tasks match the current filters" when filtered
     (already shipped by T05; reverified).
   - `/agents/[name]` (Tasks tab) empty → "No tasks for this agent
     yet" (already shipped by T04 via `<TaskTable>`; reverified).
   - `/agents/[name]` (Memory tab) empty → "No memory recorded …"
     (already shipped by T10; reverified).
   - `/tasks/[id]` empty → "No result yet" + "No transcript on disk"
     (already shipped by T06/T07; reverified).
   - `/cost` empty → "No completed tasks yet" (already shipped by
     T09; reverified).
7. `bun test` passes, including the new tests below.
8. `bun run typecheck` clean.

## Out of scope (defer)

- Per-segment error boundaries below `app/error.tsx`. The root
  boundary is sufficient for Phase 1 — anything that crashes a
  server component renders the same fallback regardless of segment.
  Phase 2 can split if a route benefits from a tighter blast radius.
- Sentry / error reporting wiring. Phase 4+.
- Replacing the `app/loops/page.tsx` / `app/schedules/page.tsx` stubs
  with real surfaces. Loops are P3-T1; Schedules are P3-T5 — they
  remain stubs in Phase 1's shell.
- React Suspense boundaries in nested components. The `loading.tsx`
  files at the route level cover the FCP budget.

## TDD plan

**RED — write tests first, see them fail:**

1. `tests/lib/bridge-error.test.ts`
   - `isBridgeNotInstalledError(new BridgeNotInstalledError("/x"))`
     → true.
   - `isBridgeNotInstalledError({ name: "BridgeNotInstalledError" })`
     → true (cross-boundary serialized error case).
   - `isBridgeNotInstalledError(new Error("boom"))` → false.
   - `isBridgeNotInstalledError(null)` /
     `isBridgeNotInstalledError(undefined)` /
     `isBridgeNotInstalledError("oops")` → false (defensive).

2. `tests/app/error-boundary.test.ts`
   - `app/error.tsx` exports a default function.
   - Source contains the `"use client"` pragma at byte 0
     (regex on the file contents).
   - Rendering with a `BridgeNotInstalledError`-shaped object
     produces HTML containing the offline copy ("Daemon offline" +
     `bridge install` + the path).
   - Rendering with a generic `Error` produces HTML containing the
     generic fallback ("Something went wrong") and the error
     message in `<pre>`. NOT the offline copy.
   - The "Try again" / "Retry" buttons are rendered as `<button>`
     elements.

3. `tests/app/loading-states.test.ts`
   - Each of `app/loading.tsx`, `app/agents/loading.tsx`,
     `app/tasks/loading.tsx`, `app/cost/loading.tsx` exists.
   - Each module exports a default function.
   - Each rendered HTML contains the
     `animate-pulse` Tailwind utility (skeleton signature).

4. `tests/app/offline-banner.test.ts`
   - `<OfflineBanner home="/tmp/.claude-bridge" />` renders the
     supplied path + the `bridge install` remediation copy.

5. `tests/app/route-stubs.test.ts` (extend the existing file from
   T01) — already covers default-export presence; no change needed.

**GREEN — implement the minimum to pass:**

- `src/lib/bridge-error.ts`: name-based predicate. No imports from
  `discovery.ts` (avoid a heavy import path). Re-export
  `BRIDGE_NOT_INSTALLED_NAME = "BridgeNotInstalledError"` for sharing.
- `src/components/ui/skeleton.tsx`: `<Skeleton className />` —
  `<div role="status" aria-busy className="animate-pulse rounded-md
  bg-[hsl(var(--muted))]" />`.
- `src/components/offline-banner.tsx`: Card-shaped server component
  taking `{ home }` plus optional `{ configPath }`. Renders heading,
  path, remediation block.
- `app/error.tsx`: client component; default export
  `RootError({ error, reset })`. Branches on
  `isBridgeNotInstalledError(error)` and renders the
  `<OfflineBanner>`; otherwise renders the generic fallback. Both
  branches show a `<button onClick={reset}>` retry control.
- `app/loading.tsx`: page-shaped skeleton (heading bar + 6 card
  squares).
- `app/agents/loading.tsx`: skeleton tuned to the agents grid (heading
  + 4 card placeholders in a 2-col grid).
- `app/tasks/loading.tsx`: skeleton for the tasks table (heading +
  filter bar + 8 row strips).
- `app/cost/loading.tsx`: skeleton for the cost dashboard (3 KPI
  cards + a tall chart placeholder).

**Empty-state audit:** the existing inline empty branches in
`<AgentsGrid>`, `<TaskTable>`, `<GlobalTaskTable>`, the agent-detail
memory section, the task-detail result/transcript sections, and the
cost page all satisfy bullet 6. T11 does not change them; the review
will list each one explicitly.

## Test fixtures / helpers

- For the error-boundary test, build a fake error via
  `Object.assign(new Error(msg), { name: "BridgeNotInstalledError",
  home: "/tmp/.claude-bridge", configPath:
  "/tmp/.claude-bridge/config.json" })`. Avoids importing
  `BridgeNotInstalledError` directly so the test doubles as a check
  that the boundary is name-discriminated (not instanceof-based,
  which would fail across server/client serialization).

## Open questions / risks

- **Skeleton flash on fast machines.** Next.js renders `loading.tsx`
  for a tick even when the page resolves in <50 ms. Acceptable for
  Phase 1; if the flash becomes annoying, T12/Phase 2 can wrap the
  skeleton in a `min-height` Suspense delay. Documented in the
  review.
- **Error boundary recovery state.** `reset()` re-renders the segment
  on the same RSC tree — if the underlying error is permanent (config
  missing), the boundary re-fires until the user fixes it. That's
  intended UX; the offline copy explicitly says "fix the config and
  reload".
- **`BridgeNotInstalledError` discovery wiring.** Current Phase 1
  code does **not** call `discoverBridgeDaemon()` from any page —
  every page reads `bridge.db` directly via `getDb()`. So in
  practice the offline banner would only fire if a future page calls
  the discovery helper and re-throws. The wiring is intentional: we
  ship the boundary now so Phase 2 surfaces (which need the
  daemon socket / MCP endpoint) can rely on it without revisiting
  T11. Recorded as a Phase 1 "ready for future use" deliverable.
- **`error.tsx` typing.** Next.js's `error.tsx` prop type is
  `{ error: Error & { digest?: string }; reset: () => void }`. We
  type explicitly so the test renderer's fake-error path stays
  type-safe.

## Read-only invariant check

- `app/error.tsx` and the loading skeletons issue **zero** tRPC
  calls, **zero** DB queries, **zero** writes to disk.
- `<OfflineBanner>` is a pure server component — no `"use client"`,
  no state, no fetch.
- `isBridgeNotInstalledError` reads only from the input value's
  `name` field; never invokes a side-effect.
- The retry button calls `reset()` — Next.js's React boundary reset,
  not a mutation.
