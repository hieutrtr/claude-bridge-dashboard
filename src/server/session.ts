// P4-T03 — server-side session-subject helper for App Router pages.
//
// `middleware.ts` already redirects unauthenticated requests away from
// any non-public route, so a page rendering past the middleware gate
// is guaranteed to have a valid session cookie. Page server components
// still need to *read* that cookie and forward the JWT subject onto
// the tRPC `createCaller` context so the new RBAC middleware
// (`authedProcedure` / `ownerProcedure` in `src/server/trpc.ts`) sees
// a non-null `userId` and lets the procedure run.
//
// Returns `null` only if the cookie/secret is missing (the signed-out
// fallback). The page can choose to render a "not signed in" splash
// when this happens — but in practice the middleware redirect kicks
// in before the page renders.

import { cookies } from "next/headers";

import { SESSION_COOKIE, readAuthEnv, verifySession } from "@/src/lib/auth";

const STATE_KEY = "__bridge_session_subject_override__";

interface OverrideState {
  override: string | null;
  active: boolean;
}

function readOverride(): OverrideState {
  const g = globalThis as unknown as Record<string, OverrideState | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = { override: null, active: false };
    g[STATE_KEY] = s;
  }
  return s;
}

/**
 * Test seam — when set, `getSessionSubject` returns this value without
 * touching `next/headers cookies`. Pass `null` to simulate a signed-out
 * caller. The override stays in effect until `__clearSessionSubjectForTest()`
 * is called. Production code must NEVER call this.
 */
export function __setSessionSubjectForTest(value: string | null): void {
  const s = readOverride();
  s.override = value;
  s.active = true;
}

export function __clearSessionSubjectForTest(): void {
  const s = readOverride();
  s.override = null;
  s.active = false;
}

export async function getSessionSubject(): Promise<string | null> {
  const ov = readOverride();
  if (ov.active) return ov.override;

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
