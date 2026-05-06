// P4-T02 — `users.*` tRPC router (owner-only).
//
// Surface (per docs/tasks/phase-4/INDEX.md T02):
//
//   users.list()                      — Query.   owner-only.
//   users.invite({ email, role })     — Mutation.owner-only.
//   users.revoke({ id })              — Mutation.owner-only. Cannot revoke self.
//   users.changeRole({ id, role })    — Mutation.owner-only. Cannot demote
//                                       the last remaining owner (incl. self).
//
// RBAC (P4-T03): every procedure uses `ownerProcedure` from `../trpc`,
// which runs `requireOwner(ctx, path)` from `src/server/rbac.ts`. The
// middleware throws `UNAUTHORIZED` for unauthenticated callers and
// `FORBIDDEN` for non-owners, audits a `rbac_denied` row with the
// requested route as `resource_type`, and exposes the resolved owner
// `UserRow` on `ctx.user` for the procedure body's "cannot revoke
// yourself" / "cannot demote last owner" checks. The audit shape was
// frozen against T02's prior inline guard so existing forensics keep
// working unchanged.
//
// Privacy — every audit payload encodes `targetEmailHash` (never the
// plaintext email). The list query does NOT audit (consistent with
// Phase 2 / 3: only mutations are recorded). Returned email plaintext
// is required for the UI table; the privacy boundary is the `audit_log`
// table, not the API surface.
//
// Invite flow — T02 creates the `users` row with `role=member` (or
// `role=owner` if explicitly invited as such). The invitee receives a
// magic-link via the existing `auth.requestMagicLink` flow when they
// hit `/login` — T02 does NOT auto-fire an email. Documented in
// T02-review §3 as a deliberate choice (avoids duplicating the rate-
// limit / Resend graceful-fail surface; reuses the well-tested path).
// The invite mutation IS idempotent: inviting an existing email is a
// no-op (returns the existing row) so a typo + retry doesn't crash.

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { ownerProcedure, router } from "../trpc";
import { getSqlite } from "../db";
import { appendAudit } from "../audit";
import {
  findOrCreateUser,
  findUserById,
  type UserRow,
} from "../auth-users";
import {
  emailHash as makeEmailHash,
  normalizeEmail,
  resolveAuditSalt,
} from "@/src/lib/email-hash";

export interface UserListRow {
  id: string;
  email: string;
  role: "owner" | "member";
  displayName: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface UserMutationResult {
  ok: true;
  /** True when a previously revoked user was re-activated by `invite`. */
  reactivated?: boolean;
  /** True when `invite` matched an existing active user (no-op). */
  alreadyExisted?: boolean;
  /** True when `revoke`/`changeRole` was called against an already-target state. */
  alreadyApplied?: boolean;
}

const InviteInput = z.object({
  email: z.string().min(3).max(320).email(),
  role: z.enum(["owner", "member"]).default("member"),
});

const RevokeInput = z.object({
  id: z.string().min(1).max(64),
});

const ChangeRoleInput = z.object({
  id: z.string().min(1).max(64),
  role: z.enum(["owner", "member"]),
});

interface AuditTargetMeta {
  targetUserId: string;
  targetEmailHash: string;
}

function targetMeta(target: UserRow): AuditTargetMeta {
  const salt = resolveAuditSalt();
  return {
    targetUserId: target.id,
    targetEmailHash: salt
      ? makeEmailHash(target.email, salt)
      : "no-salt",
  };
}

function callerEmailHash(caller: UserRow): string {
  const salt = resolveAuditSalt();
  return salt ? makeEmailHash(caller.email, salt) : "no-salt";
}

interface RawListRow {
  id: string;
  email: string;
  role: string;
  display_name: string | null;
  created_at: number;
  last_login_at: number | null;
}

function listActiveUsers(): UserListRow[] {
  const db = getSqlite();
  const rows = db
    .prepare(
      `SELECT id, email, role, display_name, created_at, last_login_at
         FROM users
        WHERE revoked_at IS NULL
        ORDER BY role = 'owner' DESC,
                 last_login_at DESC NULLS LAST,
                 created_at DESC,
                 id ASC`,
    )
    .all() as RawListRow[];
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role === "owner" ? "owner" : "member",
    displayName: r.display_name,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  }));
}

function countActiveOwners(): number {
  const db = getSqlite();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
        WHERE role = 'owner' AND revoked_at IS NULL`,
    )
    .get() as { n: number } | null;
  return row?.n ?? 0;
}

function reactivateUser(id: string, role: "owner" | "member"): void {
  const db = getSqlite();
  db.prepare(
    `UPDATE users SET revoked_at = NULL, role = ? WHERE id = ?`,
  ).run(role, id);
}

function setRevokedAt(id: string, now: number): void {
  const db = getSqlite();
  db.prepare(`UPDATE users SET revoked_at = ? WHERE id = ?`).run(now, id);
}

function setRole(id: string, role: "owner" | "member"): void {
  const db = getSqlite();
  db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, id);
}

export const usersRouter = router({
  // P4-T02 — `users.list`. Owner-only. Returns active (non-revoked)
  // users sorted with owners first, then most-recently-active members.
  list: ownerProcedure.query((): UserListRow[] => {
    return listActiveUsers();
  }),

  // P4-T02 — `users.invite`. Owner-only. Creates the row at
  // `role=member` (default) or `role=owner`. Idempotent: an existing
  // active row returns `alreadyExisted: true`; a previously revoked
  // row is re-activated and returns `reactivated: true`.
  //
  // Privacy: audit payload encodes `targetEmailHash` only.
  invite: ownerProcedure
    .input(InviteInput)
    .mutation(({ ctx, input }): UserMutationResult => {
      const caller = ctx.user;

      const email = normalizeEmail(input.email);
      const auditBase = {
        userId: caller.id,
        req: ctx.req,
      } as const;

      const db = getSqlite();
      const existing = db
        .prepare(
          `SELECT id, email, role, display_name, created_at, last_login_at, revoked_at
             FROM users WHERE email_lower = ?`,
        )
        .get(email) as
          | (RawListRow & { revoked_at: number | null })
          | undefined;

      if (existing && existing.revoked_at === null) {
        // Already active. No-op + audit so the caller's intent is
        // recorded without flipping role unintentionally.
        appendAudit({
          ...auditBase,
          action: "user.invite",
          resourceType: "user",
          resourceId: existing.id,
          payload: {
            targetUserId: existing.id,
            targetEmailHash: targetMeta({
              id: existing.id,
              email: existing.email,
              role: existing.role === "owner" ? "owner" : "member",
              displayName: existing.display_name,
              createdAt: existing.created_at,
              lastLoginAt: existing.last_login_at,
              revokedAt: null,
            }).targetEmailHash,
            requestedRole: input.role,
            alreadyExisted: true,
          },
        });
        return { ok: true, alreadyExisted: true };
      }

      if (existing && existing.revoked_at !== null) {
        // Re-activate at the requested role. Records the role change
        // explicitly so the audit row can be diff'd against a future
        // changeRole flip.
        reactivateUser(existing.id, input.role);
        appendAudit({
          ...auditBase,
          action: "user.invite",
          resourceType: "user",
          resourceId: existing.id,
          payload: {
            targetUserId: existing.id,
            targetEmailHash: targetMeta({
              id: existing.id,
              email: existing.email,
              role: existing.role === "owner" ? "owner" : "member",
              displayName: existing.display_name,
              createdAt: existing.created_at,
              lastLoginAt: existing.last_login_at,
              revokedAt: null,
            }).targetEmailHash,
            requestedRole: input.role,
            previousRole: existing.role,
            reactivated: true,
          },
        });
        return { ok: true, reactivated: true };
      }

      // New row. `findOrCreateUser` is the canonical insert path —
      // re-using it keeps the privacy + UUID + race-safe upsert
      // behaviour consistent with the magic-link consume route.
      const created = findOrCreateUser({
        email: input.email,
        defaultRole: input.role,
      });
      appendAudit({
        ...auditBase,
        action: "user.invite",
        resourceType: "user",
        resourceId: created.id,
        payload: {
          ...targetMeta(created),
          requestedRole: input.role,
        },
      });
      return { ok: true };
    }),

  // P4-T02 — `users.revoke`. Owner-only. Soft-deletes the user by
  // setting `revoked_at`. Cannot revoke self (would lock you out).
  // `users.list` filters revoked rows; the magic-link consume route
  // refuses revoked users (T01).
  revoke: ownerProcedure
    .input(RevokeInput)
    .mutation(({ ctx, input }): UserMutationResult => {
      const caller = ctx.user;

      if (input.id === caller.id) {
        appendAudit({
          action: "user.revoke.error",
          resourceType: "user",
          resourceId: input.id,
          userId: caller.id,
          payload: {
            targetUserId: input.id,
            callerEmailHash: callerEmailHash(caller),
            code: "self_revoke_blocked",
          },
          req: ctx.req,
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "cannot revoke yourself",
        });
      }

      const target = findUserById(input.id);
      if (!target) {
        appendAudit({
          action: "user.revoke.error",
          resourceType: "user",
          resourceId: input.id,
          userId: caller.id,
          payload: {
            targetUserId: input.id,
            code: "NOT_FOUND",
          },
          req: ctx.req,
        });
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "user not found",
        });
      }

      if (target.revokedAt !== null) {
        appendAudit({
          action: "user.revoke",
          resourceType: "user",
          resourceId: target.id,
          userId: caller.id,
          payload: {
            ...targetMeta(target),
            alreadyApplied: true,
          },
          req: ctx.req,
        });
        return { ok: true, alreadyApplied: true };
      }

      setRevokedAt(target.id, Date.now());
      appendAudit({
        action: "user.revoke",
        resourceType: "user",
        resourceId: target.id,
        userId: caller.id,
        payload: {
          ...targetMeta(target),
          previousRole: target.role,
        },
        req: ctx.req,
      });
      return { ok: true };
    }),

  // P4-T02 — `users.changeRole`. Owner-only. Promotes / demotes a
  // user. Cannot demote the LAST active owner — the system would be
  // permanently locked out of owner-only operations otherwise. The
  // last-owner check counts active rows and is taken under the same
  // `db` handle so a concurrent revoke can't race the count to zero.
  changeRole: ownerProcedure
    .input(ChangeRoleInput)
    .mutation(({ ctx, input }): UserMutationResult => {
      const caller = ctx.user;

      const target = findUserById(input.id);
      if (!target) {
        appendAudit({
          action: "user.role-change.error",
          resourceType: "user",
          resourceId: input.id,
          userId: caller.id,
          payload: { targetUserId: input.id, code: "NOT_FOUND" },
          req: ctx.req,
        });
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "user not found",
        });
      }

      if (target.revokedAt !== null) {
        appendAudit({
          action: "user.role-change.error",
          resourceType: "user",
          resourceId: target.id,
          userId: caller.id,
          payload: {
            ...targetMeta(target),
            code: "user_revoked",
          },
          req: ctx.req,
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "cannot change role of a revoked user",
        });
      }

      if (target.role === input.role) {
        appendAudit({
          action: "user.role-change",
          resourceType: "user",
          resourceId: target.id,
          userId: caller.id,
          payload: {
            ...targetMeta(target),
            oldRole: target.role,
            newRole: input.role,
            alreadyApplied: true,
          },
          req: ctx.req,
        });
        return { ok: true, alreadyApplied: true };
      }

      // Last-owner gate. Count active owners; a demote that would
      // leave zero active owners is refused. Demotion of self is
      // covered by the same gate (the caller is by definition an
      // active owner; n=1 ⇒ the only active owner is `caller`).
      if (target.role === "owner" && input.role !== "owner") {
        const owners = countActiveOwners();
        if (owners <= 1) {
          appendAudit({
            action: "user.role-change.error",
            resourceType: "user",
            resourceId: target.id,
            userId: caller.id,
            payload: {
              ...targetMeta(target),
              oldRole: target.role,
              newRole: input.role,
              code: "last_owner",
              activeOwners: owners,
            },
            req: ctx.req,
          });
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "cannot demote the last owner",
          });
        }
      }

      setRole(target.id, input.role);
      appendAudit({
        action: "user.role-change",
        resourceType: "user",
        resourceId: target.id,
        userId: caller.id,
        payload: {
          ...targetMeta(target),
          oldRole: target.role,
          newRole: input.role,
        },
        req: ctx.req,
      });
      return { ok: true };
    }),
});
