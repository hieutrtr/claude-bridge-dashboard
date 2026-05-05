// tRPC fetch adapter mounted on Next.js App Router. POST mutations are
// gated by the CSRF guard (T08) — see docs/adr/0001-csrf-strategy.md.
// GET queries are exempt; the guard short-circuits on safe methods.

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../../../../src/server/routers/_app";
import { csrfGuard } from "../../../../src/server/csrf-guard";

const handler = async (req: Request) => {
  const blocked = await csrfGuard(req);
  if (blocked) return blocked;
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => ({}),
  });
};

export { handler as GET, handler as POST };
