// P4-T01 — `auth.*` tRPC router.
//
// Surface (per `docs/tasks/phase-4/INDEX.md` T01 spec):
//
//   auth.me() — Query. Returns `{ id, email, role, displayName }` for
//     the current session, or `null` when the session is missing /
//     expired / points at a revoked user. Returning `null` (not
//     throwing) lets the dashboard render a graceful "logged out"
//     state without a TRPCError round-trip.
//
//   auth.logout() — Mutation. Audits the action and returns
//     `{ ok: true }`. Cookie clearing happens at the route layer
//     (`/api/auth/logout` already does the cookie work + CSRF check
//     under Phase 1). The mutation exists so the SPA can clear local
//     UI state via tRPC; the dashboard's client wrapper still POSTs
//     to `/api/auth/logout` to actually drop the cookies.
//
// `requestMagicLink` / `consumeMagicLink` deliberately live on
// dedicated REST routes (`/api/auth/magic-link/*`) instead of the
// tRPC router because (a) the consume URL is a one-shot GET embedded
// in an email and must redirect rather than return JSON, and (b) the
// request POST is fired from the public `/login` page which has no
// session cookie and would fail the CSRF guard. See T01 review for
// the rationale.

import { z } from "zod";

import { publicProcedure, router } from "../trpc";
import { appendAudit } from "../audit";
import { envOwnerUser, resolveSessionUser, type UserRow } from "../auth-users";

export interface AuthMeResponse {
  id: string;
  email: string;
  role: "owner" | "member";
  displayName: string | null;
}

function toMe(user: UserRow): AuthMeResponse {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
  };
}

export const authRouter = router({
  me: publicProcedure.query(({ ctx }): AuthMeResponse | null => {
    const sub = ctx.userId;
    if (!sub) return null;
    try {
      const user = resolveSessionUser(sub);
      if (user) return toMe(user);
    } catch {
      // Database unavailable (e.g. test harness without BRIDGE_DB).
      // Fall back to the synthetic env-owner identity for the legacy
      // "owner" sub so the existing UI keeps working in dev.
    }
    if (sub === "owner") return toMe(envOwnerUser());
    return null;
  }),

  logout: publicProcedure
    .input(z.object({}).optional())
    .mutation(({ ctx }) => {
      appendAudit({
        action: "auth.logout",
        resourceType: "auth",
        userId: ctx.userId ?? null,
        req: ctx.req,
      });
      return { ok: true as const };
    }),
});
