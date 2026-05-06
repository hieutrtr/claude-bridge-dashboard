// P2-T05 — `audit.*` router. Read-side over the dashboard-owned
// `audit_log` table (T04) for the `/audit` viewer page.
//
// Phase 2 ships only `list`; a future Phase 4 admin task may add
// `distinctActions` (for a filter datalist), `count`, or a CSV export.
//
// Owner-only enforcement note: this single-user dashboard is gated by
// the same auth middleware that protects every other page. We do NOT
// re-check `ctx.userId === "owner"` at the procedure level — Phase 1
// stubbed JWT auth without a role concept. When multi-user lands
// (Phase 4) add an authz middleware here that throws FORBIDDEN for
// non-owners. Documented in PHASE-2-COMPLETE.md.
//
// Cursor + ordering — keyset on `id` (`id < ?`) ordered by
// `(created_at DESC, id DESC)`. The `id` tiebreak is load-bearing:
// audit rows can share `created_at` ms (T07/T08 guards each fire
// dozens of rows during a token-bucket exhaust), and an order on
// `created_at` alone could reorder rows across pages. The `id` is
// AUTOINCREMENT-monotonic so cursor advances safely.
//
// `userId` filter — exact match `eq(user_id, ?)`, with the special
// sentinel `"<anonymous>"` rewritten to `IS NULL` so the user can
// filter for pre-auth rows (csrf_invalid + rate-limit-login). Drizzle
// emits `eq(col, null)` as `col = NULL`, which is always false in
// SQL — using `isNull()` avoids that footgun.

import { z } from "zod";
import { and, desc, eq, gte, isNull, lt, lte } from "drizzle-orm";

import { publicProcedure, router } from "../trpc";
import { getDb } from "../db";
import { auditLog } from "../../db/schema";
import type { AuditLogPage, AuditLogRow } from "../dto";

const ANONYMOUS_USER_SENTINEL = "<anonymous>";

const ListInput = z.object({
  action: z.string().min(1).optional(),
  resourceType: z.string().min(1).optional(),
  // Free-form. Sentinel `"<anonymous>"` matches NULL user_id rows.
  userId: z.string().min(1).optional(),
  since: z.number().int().min(0).optional(),
  until: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).default(100),
  cursor: z.number().int().positive().optional(),
});

const AUDIT_LOG_SELECTION = {
  id: auditLog.id,
  userId: auditLog.userId,
  action: auditLog.action,
  resourceType: auditLog.resourceType,
  resourceId: auditLog.resourceId,
  payloadJson: auditLog.payloadJson,
  ipHash: auditLog.ipHash,
  userAgent: auditLog.userAgent,
  requestId: auditLog.requestId,
  createdAt: auditLog.createdAt,
} as const;

function tryParse(json: string | null): unknown | null {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export const auditRouter = router({
  list: publicProcedure
    .input(ListInput)
    .query(({ input }): AuditLogPage => {
      const db = getDb();

      const filters = [];
      if (input.action !== undefined) {
        filters.push(eq(auditLog.action, input.action));
      }
      if (input.resourceType !== undefined) {
        filters.push(eq(auditLog.resourceType, input.resourceType));
      }
      if (input.userId !== undefined) {
        if (input.userId === ANONYMOUS_USER_SENTINEL) {
          filters.push(isNull(auditLog.userId));
        } else {
          filters.push(eq(auditLog.userId, input.userId));
        }
      }
      if (input.since !== undefined) {
        filters.push(gte(auditLog.createdAt, input.since));
      }
      if (input.until !== undefined) {
        filters.push(lte(auditLog.createdAt, input.until));
      }
      if (input.cursor !== undefined) {
        filters.push(lt(auditLog.id, input.cursor));
      }

      const rows = db
        .select(AUDIT_LOG_SELECTION)
        .from(auditLog)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(input.limit)
        .all();

      const items: AuditLogRow[] = rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        payloadJson: r.payloadJson,
        payload: tryParse(r.payloadJson),
        ipHash: r.ipHash,
        userAgent: r.userAgent,
        requestId: r.requestId,
        createdAt: r.createdAt,
      }));

      const nextCursor =
        items.length === input.limit ? (items[items.length - 1]!.id ?? null) : null;
      return { items, nextCursor };
    }),
});
