// P2-T09 — `permissions.*` router. Phase 2 ships only the
// `respond` mutation: the dashboard's Allow / Deny surface for the
// daemon's permission-relay flow.
//
// Architecture — v1 ARCH §10 inherits the existing `permissions`
// table contract: the daemon polls `permissions.id` every 2s for a
// `status` change. The dashboard does **not** call an MCP tool; it
// updates the row directly. Idempotency mirrors `tasks.kill` and
// `loops.approve/reject`:
//
//   1. Server-side check — when the row's `status` is no longer
//      `pending`, return `{ ok:true, alreadyResolved:true }` with one
//      audit row recording the no-op. Telegram (or another tab) won
//      the race; the user's intent — that the permission decision is
//      taken — is satisfied.
//   2. Happy path — single SQL `UPDATE` setting `status`, `response`,
//      and `responded_at`. The daemon picks it up on its next poll
//      (worst-case ≈ 2s).
//
// Privacy — the audit payload **never** includes the `command` text.
// Permission requests can carry shell snippets users would not want
// in a log. The audit row records `decision`, `toolName`, and
// `sessionId` only.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { authedProcedure, router } from "../trpc";
import { getDb, getSqlite } from "../db";
import { permissions } from "../../db/schema";
import { appendAudit } from "../audit";

const RespondInput = z.object({
  id: z.string().min(1).max(32),
  decision: z.enum(["approved", "denied"]),
});

export interface PermissionRespondResult {
  ok: true;
  alreadyResolved: boolean;
}

interface PermLookup {
  status: string | null;
  toolName: string;
  sessionId: string;
}

function lookupPermission(id: string): PermLookup | undefined {
  const db = getDb();
  return db
    .select({
      status: permissions.status,
      toolName: permissions.toolName,
      sessionId: permissions.sessionId,
    })
    .from(permissions)
    .where(eq(permissions.id, id))
    .limit(1)
    .all()[0];
}

function updatePermission(
  id: string,
  decision: "approved" | "denied",
): void {
  // Use bun:sqlite directly so we can drive `responded_at = CURRENT_TIMESTAMP`
  // without a Drizzle-side `sql` import (matches the daemon's behaviour
  // — see `src/infra/permissions.ts` `respondPermission`).
  const sqlite = getSqlite();
  sqlite
    .prepare(
      `UPDATE permissions
         SET status = ?, response = ?, responded_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(decision, decision, id);
}

export const permissionsRouter = router({
  // P2-T09 — respond to a daemon-issued permission request. The Allow
  // / Deny buttons in the dashboard toast call this; CSRF + rate-limit
  // guards run at the route handler.
  respond: authedProcedure
    .input(RespondInput)
    .mutation(async ({ input, ctx }): Promise<PermissionRespondResult> => {
      const row = lookupPermission(input.id);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "permission not found",
        });
      }

      const auditBase = {
        resourceType: "permission" as const,
        resourceId: input.id,
        userId: ctx.userId ?? null,
        req: ctx.req,
      };

      // Path A — already resolved (race with another channel). No
      // UPDATE; audit the no-op.
      if (row.status !== "pending") {
        appendAudit({
          ...auditBase,
          action: "permission.respond",
          payload: {
            decision: input.decision,
            toolName: row.toolName,
            sessionId: row.sessionId,
            alreadyResolved: true,
          },
        });
        return { ok: true, alreadyResolved: true };
      }

      // Path B — flip the row.
      try {
        updatePermission(input.id, input.decision);
      } catch (err) {
        appendAudit({
          ...auditBase,
          action: "permission.respond.error",
          payload: {
            decision: input.decision,
            toolName: row.toolName,
            sessionId: row.sessionId,
            code: "db_error",
          },
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            err instanceof Error
              ? `permission update failed: ${err.message}`
              : "permission update failed",
          cause: err,
        });
      }

      appendAudit({
        ...auditBase,
        action: "permission.respond",
        payload: {
          decision: input.decision,
          toolName: row.toolName,
          sessionId: row.sessionId,
          alreadyResolved: false,
        },
      });
      return { ok: true, alreadyResolved: false };
    }),
});
