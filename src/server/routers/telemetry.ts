// P4-T11 — `telemetry.*` tRPC router (anonymous, no PII).
//
// Surface (per docs/tasks/phase-4/INDEX.md T11):
//
//   telemetry.optInStatus()
//     — Query.    authedProcedure. Returns
//                 `{ enabled, installId? }`. `installId` is included
//                 only when `enabled === true` so the toggle UI can
//                 surface it under the explanation block. Anonymous
//                 callers cannot read this surface.
//   telemetry.setOptIn({ enabled })
//     — Mutation. **owner-only**. Toggles the install-scoped boolean
//                 in `dashboard_meta`. Audits with action
//                 `telemetry.opt-in-toggle`. Generates the install-id
//                 the first time the toggle flips ON so the value is
//                 stable for downstream rows.
//   telemetry.record({ eventType, eventName, valueMs? })
//     — Mutation. authedProcedure. NO-OP when opt-in is OFF. Routes
//                 through the PII scrubber from
//                 `src/lib/telemetry-pii.ts`. Does NOT audit (audit
//                 every event would defeat the privacy purpose AND
//                 generate orders of magnitude more rows than the
//                 audit log can sensibly hold).
//   telemetry.recent({ limit? })
//     — Query.    **owner-only**. Backs the "View what we collect"
//                 panel on `/settings/telemetry`. Returns up to 200
//                 most-recent rows. Members get FORBIDDEN — only the
//                 owner needs to audit the install-scoped feed.
//
// RBAC summary:
//   * `setOptIn` — ownerProcedure (toggle is install-wide).
//   * `optInStatus` — authedProcedure (every authenticated caller can
//                     read whether telemetry is on; this is not
//                     sensitive — it's literally the toggle they may
//                     have just opened the page to inspect).
//   * `record` — authedProcedure (any signed-in user's UI ping is
//                 valid; rows are install-scoped, not user-scoped).
//   * `recent` — ownerProcedure (data review surface).
//
// Audit policy:
//   * `setOptIn` audits `telemetry.opt-in-toggle` with payload
//     `{ enabled: boolean }`. The boolean IS recorded — it's a
//     meta-setting, not user data. No install-id, no caller-id beyond
//     what `appendAudit` already records as `user_id`.
//   * `record` does NOT audit per call. The Phase 4 invariant section
//     §2 has an explicit carve-out for telemetry rows — auditing them
//     would create N rows per event and re-introduce the PII via the
//     audit `user_id` column.

import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { authedProcedure, ownerProcedure, router } from "../trpc";
import { appendAudit } from "../audit";
import {
  getOrCreateInstallId,
  getTelemetryOptIn,
  setTelemetryOptIn,
} from "../dashboard-meta";
import {
  countEvents,
  listRecentEvents,
  recordEvent,
  type RecordEventResult,
} from "../telemetry-store";
import { TELEMETRY_EVENT_TYPES, TELEMETRY_LIMITS } from "../../lib/telemetry-pii";

const RecordInput = z.object({
  eventType: z.enum(TELEMETRY_EVENT_TYPES),
  eventName: z
    .string()
    .min(1)
    .max(TELEMETRY_LIMITS.EVENT_NAME_MAX_LEN),
  valueMs: z.number().int().min(0).max(TELEMETRY_LIMITS.VALUE_MS_MAX).nullable().optional(),
});

const SetOptInInput = z.object({ enabled: z.boolean() });

const RecentInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
  })
  .optional();

export interface OptInStatusResponse {
  enabled: boolean;
  /** Present only when enabled — the install-scoped UUID. */
  installId: string | null;
  counts: {
    total: number;
    pageView: number;
    actionLatency: number;
    featureUsed: number;
  };
}

export interface SetOptInResponse {
  enabled: boolean;
  installId: string | null;
  changed: boolean;
}

export interface RecordEventResponse {
  status: RecordEventResult["status"];
  /** Present only on `accepted`. */
  id: number | null;
  /** Present only on `accepted`. */
  eventName: string | null;
  /** Present only on `dropped_pii`. */
  reason: string | null;
}

export interface RecentEventsResponse {
  events: ReadonlyArray<{
    id: number;
    eventType: string;
    eventName: string;
    valueMs: number | null;
    createdAt: number;
  }>;
}

export const telemetryRouter = router({
  optInStatus: authedProcedure.query(({}): OptInStatusResponse => {
    const enabled = getTelemetryOptIn();
    const installId = enabled ? getOrCreateInstallId() : null;
    return { enabled, installId, counts: countEvents() };
  }),

  setOptIn: ownerProcedure
    .input(SetOptInInput)
    .mutation(({ ctx, input }): SetOptInResponse => {
      const before = getTelemetryOptIn();
      const changed = before !== input.enabled;
      if (changed) setTelemetryOptIn(input.enabled);
      // Generate the install-id eagerly on first opt-in so the very
      // next `record` call already has a stable id. Re-flipping OFF
      // does NOT delete the id (so a future opt-in resumes the same
      // anonymous identity).
      const installId = input.enabled ? getOrCreateInstallId() : null;

      appendAudit({
        action: "telemetry.opt-in-toggle",
        resourceType: "telemetry",
        userId: ctx.user.id,
        payload: { enabled: input.enabled, changed },
        req: ctx.req,
      });

      return { enabled: input.enabled, installId, changed };
    }),

  record: authedProcedure
    .input(RecordInput)
    .mutation(({ input }): RecordEventResponse => {
      const result = recordEvent({
        eventType: input.eventType,
        eventName: input.eventName,
        valueMs: input.valueMs ?? null,
      });
      if (result.status === "accepted") {
        return {
          status: "accepted",
          id: result.id,
          eventName: result.eventName,
          reason: null,
        };
      }
      if (result.status === "dropped_off") {
        return {
          status: "dropped_off",
          id: null,
          eventName: null,
          reason: null,
        };
      }
      // dropped_pii — surface the reason to the client (route prefix
      // logic can use it to fix instrumentation) but DON'T echo the
      // offending string. The reason is a fixed enum so it cannot
      // smuggle PII back.
      return {
        status: "dropped_pii",
        id: null,
        eventName: null,
        reason: result.reason,
      };
    }),

  recent: ownerProcedure
    .input(RecentInput)
    .query(({ input }): RecentEventsResponse => {
      const limit = input?.limit ?? 25;
      const events = listRecentEvents(limit);
      // Defensive: should never throw — the store already enforces the
      // PII scrubber on write — but cast to a plain shape for the wire.
      return {
        events: events.map((e) => ({
          id: e.id,
          eventType: e.eventType,
          eventName: e.eventName,
          valueMs: e.valueMs,
          createdAt: e.createdAt,
        })),
      };
    }),
});

// `TRPCError` is referenced indirectly via the `ownerProcedure` middleware
// throwing on members. We import it here to keep the dependency explicit
// for readers and TypeScript treeshaking.
void TRPCError;
