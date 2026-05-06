// P4-T06 — `notifications.*` tRPC router.
//
// Surface (per docs/tasks/phase-4/INDEX.md T06):
//
//   notifications.preferences()
//     — Query.    self-only. Reads (or creates with defaults) the
//                  caller's notification_preferences row.
//   notifications.update({ inAppEnabled?, emailDigestEnabled?,
//                          emailDigestHour?, emailDigestTz?,
//                          browserPushEnabled? })
//     — Mutation. self-only. Partial update; missing fields keep
//                  their persisted value. Audits a single
//                  `notification.preferences-update` row with the
//                  CHANGED KEYS only — never the values, per the
//                  Phase 4 privacy invariant.
//   notifications.reset()
//     — Mutation. self-only. Resets all fields to migration defaults
//                  (in_app=true, email_digest=false, hour=9, tz=UTC,
//                  push=false). DangerConfirm-wrapped client side.
//
// RBAC: every procedure uses `authedProcedure` — any authenticated
// user (owner or member) may read AND write THEIR OWN row. Owners
// cannot edit other users' prefs from this router (would defeat the
// "self-only" semantics; cross-user admin lives in `users.*`).
//
// Audit privacy — payload encodes:
//   { changes: ["emailDigestEnabled", "emailDigestHour"] }
// (key list ONLY, no values). The `update` mutation does NOT echo
// the email plaintext, the new hour, or any tz. This matches the
// `notification.preferences-update` action documented in the Phase 4
// INDEX privacy section.

import { z } from "zod";

import { authedProcedure, router } from "../trpc";
import { appendAudit } from "../audit";
import {
  DEFAULT_PREFS,
  findOrCreatePreferences,
  updatePreferences,
  type NotificationPreferences,
} from "../notification-prefs";

// IANA TZ string — keep the validation light (length + ASCII safe
// chars). The digest job catches a malformed TZ at send time via the
// `Intl.DateTimeFormat` constructor; over-validating here would
// reject legitimate strings like "Etc/GMT+12".
const TZ_REGEX = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

const UpdateInput = z
  .object({
    inAppEnabled: z.boolean().optional(),
    emailDigestEnabled: z.boolean().optional(),
    emailDigestHour: z.number().int().min(0).max(23).optional(),
    emailDigestTz: z
      .string()
      .min(1)
      .max(64)
      .regex(TZ_REGEX, "invalid timezone string")
      .optional(),
    browserPushEnabled: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.inAppEnabled !== undefined ||
      v.emailDigestEnabled !== undefined ||
      v.emailDigestHour !== undefined ||
      v.emailDigestTz !== undefined ||
      v.browserPushEnabled !== undefined,
    { message: "at least one field must be provided" },
  );

export interface NotificationPreferencesResponse {
  inAppEnabled: boolean;
  emailDigestEnabled: boolean;
  emailDigestHour: number;
  emailDigestTz: string;
  browserPushEnabled: boolean;
  updatedAt: number;
}

function toResponse(
  p: NotificationPreferences,
): NotificationPreferencesResponse {
  return {
    inAppEnabled: p.inAppEnabled,
    emailDigestEnabled: p.emailDigestEnabled,
    emailDigestHour: p.emailDigestHour,
    emailDigestTz: p.emailDigestTz,
    browserPushEnabled: p.browserPushEnabled,
    updatedAt: p.updatedAt,
  };
}

export interface NotificationsMutationResult {
  ok: true;
  prefs: NotificationPreferencesResponse;
  /** Empty when the caller submitted a no-op update. */
  changedKeys: ReadonlyArray<
    | "inAppEnabled"
    | "emailDigestEnabled"
    | "emailDigestHour"
    | "emailDigestTz"
    | "browserPushEnabled"
  >;
}

export const notificationsRouter = router({
  preferences: authedProcedure.query(({ ctx }): NotificationPreferencesResponse => {
    const caller = ctx.user;
    const prefs = findOrCreatePreferences(caller.id);
    return toResponse(prefs);
  }),

  update: authedProcedure
    .input(UpdateInput)
    .mutation(({ ctx, input }): NotificationsMutationResult => {
      const caller = ctx.user;
      const { prefs, changedKeys } = updatePreferences({
        userId: caller.id,
        inAppEnabled: input.inAppEnabled,
        emailDigestEnabled: input.emailDigestEnabled,
        emailDigestHour: input.emailDigestHour,
        emailDigestTz: input.emailDigestTz,
        browserPushEnabled: input.browserPushEnabled,
      });

      appendAudit({
        action: "notification.preferences-update",
        resourceType: "notification_preferences",
        resourceId: caller.id,
        userId: caller.id,
        payload: { changes: [...changedKeys] },
        req: ctx.req,
      });

      return { ok: true, prefs: toResponse(prefs), changedKeys };
    }),

  reset: authedProcedure
    .input(z.object({}).optional())
    .mutation(({ ctx }): NotificationsMutationResult => {
      const caller = ctx.user;
      // Force every field to its default. `updatePreferences` only
      // writes columns that actually changed, so the audit row's
      // `changes` array reflects what the caller's reset diffed.
      const { prefs, changedKeys } = updatePreferences({
        userId: caller.id,
        inAppEnabled: DEFAULT_PREFS.inAppEnabled,
        emailDigestEnabled: DEFAULT_PREFS.emailDigestEnabled,
        emailDigestHour: DEFAULT_PREFS.emailDigestHour,
        emailDigestTz: DEFAULT_PREFS.emailDigestTz,
        browserPushEnabled: DEFAULT_PREFS.browserPushEnabled,
      });

      appendAudit({
        action: "notification.preferences-reset",
        resourceType: "notification_preferences",
        resourceId: caller.id,
        userId: caller.id,
        payload: { changes: [...changedKeys] },
        req: ctx.req,
      });

      return { ok: true, prefs: toResponse(prefs), changedKeys };
    }),
});
