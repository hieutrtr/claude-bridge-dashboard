// T5 — tRPC fetch adapter mounted on Next.js App Router. The route exists so
// future client-side calls (Phase 1+ React Query) have a stable HTTP endpoint
// at /api/trpc/<procedure>. The Phase 0 page itself uses createCaller and
// does not go through HTTP.

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../../../../src/server/routers/_app";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => ({}),
  });

export { handler as GET, handler as POST };
