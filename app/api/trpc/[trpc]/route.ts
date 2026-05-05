// tRPC fetch adapter mounted on Next.js App Router. POST mutations are
// gated by:
//   1. csrfGuard (T08) — see docs/adr/0001-csrf-strategy.md.
//   2. rateLimitMutations (T07) — see docs/tasks/phase-2/T07-rate-limit.md.
// GET queries bypass both guards.
//
// T01 (Phase 2) populates the tRPC context with `req`, `userId`, and the
// MCP client singleton so mutation procedures can call into the daemon
// and write audit rows derived from request metadata.

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../../../../src/server/routers/_app";
import { SESSION_COOKIE, readAuthEnv, verifySession } from "../../../../src/lib/auth";
import { csrfGuard } from "../../../../src/server/csrf-guard";
import { rateLimitMutations } from "../../../../src/server/rate-limit-mutations";
import { getMcpPool } from "../../../../src/server/mcp/pool";

const handler = async (req: Request) => {
  const blockedCsrf = await csrfGuard(req);
  if (blockedCsrf) return blockedCsrf;

  const sessionUserId = await readSessionSubject(req);
  const blockedRate = await rateLimitMutations(req, sessionUserId);
  if (blockedRate) return blockedRate;

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => ({
      req,
      userId: sessionUserId,
      mcp: getMcpPool(),
    }),
  });
};

async function readSessionSubject(req: Request): Promise<string | null> {
  const { secret } = readAuthEnv();
  if (!secret) return null;
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const token = part.slice(eq + 1).trim();
    if (!token) return null;
    const payload = await verifySession(token, secret);
    return payload?.sub ?? null;
  }
  return null;
}

export { handler as GET, handler as POST };
