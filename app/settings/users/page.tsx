// P4-T02 — `/settings/users` page (owner-only).
//
// Server component. Fires a tRPC `auth.me` query first to resolve the
// caller's identity (the request handler reads the session cookie) and
// branches:
//
//   * No session   → middleware already redirected to /login; we still
//                    render a minimal "not signed in" state so the page
//                    is testable in isolation.
//   * Member       → renders the FORBIDDEN copy + a "ask the owner for
//                    access" CTA. No server-side users.list call (would
//                    audit a duplicate rbac_denied row).
//   * Owner        → renders the table + invite modal trigger by
//                    delegating to the client `<UsersTable>`.
//
// Auth lives entirely on the request side — the page accepts a
// pre-validated session via the cookie and re-uses the appRouter
// caller. No `"use client"` directive on the page itself; the
// `<UsersTable>` is a client component that owns its own state.

import { cookies } from "next/headers";

import { appRouter } from "@/src/server/routers/_app";
import { SESSION_COOKIE, readAuthEnv, verifySession } from "@/src/lib/auth";
import { UsersTable } from "@/src/components/users-table";

export const dynamic = "force-dynamic";

async function readSessionSubject(): Promise<string | null> {
  const { secret } = readAuthEnv();
  if (!secret) return null;
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const payload = await verifySession(token, secret);
    return payload?.sub ?? null;
  } catch {
    return null;
  }
}

export default async function UsersSettingsPage() {
  const userId = await readSessionSubject();
  const caller = appRouter.createCaller({ userId });

  const me = await caller.auth.me();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          Manage who has access to the dashboard. Owners can invite,
          revoke, or change roles. Members can dispatch their own tasks
          and view their own cost.
        </p>
      </header>

      {me === null ? (
        <NotSignedIn />
      ) : me.role !== "owner" ? (
        <NotPermitted role={me.role} />
      ) : (
        <OwnerView callerId={me.id} />
      )}
    </div>
  );
}

async function OwnerView({ callerId }: { callerId: string }) {
  // Re-use the same caller path as the page bootstrap; the inline
  // RBAC guard inside `users.list` would also accept this call, but
  // we already know the caller is an owner so the round-trip is just
  // a query for the rendered list.
  const caller = appRouter.createCaller({ userId: callerId });
  const items = await caller.users.list();
  return <UsersTable items={items} callerId={callerId} />;
}

function NotPermitted({ role }: { role: string }) {
  return (
    <div
      className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm"
      data-role="forbidden-banner"
    >
      <p className="font-semibold text-amber-300">Owner access required</p>
      <p className="mt-2 text-[hsl(var(--muted-foreground))]">
        You're signed in as <span className="font-mono">{role}</span> —
        ask an owner to invite or promote you. Members keep full
        access to <a className="underline" href="/agents">/agents</a>,{" "}
        <a className="underline" href="/tasks">/tasks</a>, and the
        cost dashboard.
      </p>
    </div>
  );
}

function NotSignedIn() {
  return (
    <div
      className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 text-sm"
      data-role="signed-out-banner"
    >
      <p className="text-[hsl(var(--muted-foreground))]">
        Sign in via <a className="underline" href="/login">/login</a> to manage users.
      </p>
    </div>
  );
}
