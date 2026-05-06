// P4-T06 — `/settings/notifications` page (self-only).
//
// Server component. Resolves the caller via the session cookie + the
// `auth.me` tRPC query, then either renders the toggle matrix
// (`<NotificationsForm>`) or a "not signed in" CTA.
//
// Unlike `/settings/users`, this page is NOT owner-only — every
// authenticated user gets their own preferences row. Owners cannot
// edit other users' prefs from this page (that surface intentionally
// does not exist; cross-user admin lives in `/settings/users`).

import { cookies } from "next/headers";

import { appRouter } from "@/src/server/routers/_app";
import { SESSION_COOKIE, readAuthEnv, verifySession } from "@/src/lib/auth";
import { NotificationsForm } from "@/src/components/notifications-form";

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

export default async function NotificationsSettingsPage() {
  const userId = await readSessionSubject();
  const caller = appRouter.createCaller({ userId });

  const me = await caller.auth.me();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          Choose how you'd like to be told when your tasks finish.
          Email digest is opt-in; we never email you by default.
        </p>
      </header>

      {me === null ? (
        <NotSignedIn />
      ) : (
        <SelfView callerId={me.id} />
      )}
    </div>
  );
}

async function SelfView({ callerId }: { callerId: string }) {
  const caller = appRouter.createCaller({ userId: callerId });
  const initial = await caller.notifications.preferences();
  return <NotificationsForm initial={initial} />;
}

function NotSignedIn() {
  return (
    <div
      className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 text-sm"
      data-role="signed-out-banner"
    >
      <p className="text-[hsl(var(--muted-foreground))]">
        Sign in via <a className="underline" href="/login">/login</a> to manage
        notification preferences.
      </p>
    </div>
  );
}
