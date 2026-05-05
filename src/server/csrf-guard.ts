// CSRF guard — sits in front of every state-changing HTTP handler. Returns
// a Response (403 / 503) that the route handler should return verbatim, OR
// `null` to indicate "pass through to the real handler". See ADR 0001.

import { readAuthEnv, timingSafeEqual } from "@/src/lib/auth";
import { CSRF_COOKIE, CSRF_HEADER, verifyCsrfToken } from "@/src/lib/csrf";
import { appendAudit } from "@/src/server/audit";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function csrfGuard(req: Request): Promise<Response | null> {
  if (SAFE_METHODS.has(req.method)) return null;

  const { secret } = readAuthEnv();
  if (!secret) {
    return Response.json({ error: "auth_not_configured" }, { status: 503 });
  }

  const cookieToken = parseCookie(req.headers.get("cookie"), CSRF_COOKIE);
  const headerToken = req.headers.get(CSRF_HEADER);

  if (!cookieToken || !headerToken) {
    return invalid(req);
  }
  if (!timingSafeEqual(cookieToken, headerToken)) {
    return invalid(req);
  }
  if (!(await verifyCsrfToken(cookieToken, secret))) {
    return invalid(req);
  }
  return null;
}

function invalid(req: Request): Response {
  appendAudit({ action: "csrf_invalid", resourceType: "auth", req });
  return Response.json({ error: "csrf_invalid" }, { status: 403 });
}

// Minimal cookie parser — we only need to find one named cookie. Avoids
// pulling a dep for what is essentially a `split` and `trim`.
function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const v = part.slice(eq + 1).trim();
    return v.length > 0 ? v : null;
  }
  return null;
}
