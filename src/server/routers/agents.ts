// T5 — agents.* router. Phase 0 spike implements only `list`.
// Other procedures from ARCHITECTURE.md §4.1 (`get`, `create`, `delete`,
// `setModel`, `memory`, `status`, `stream`) land in Phase 1.

import { publicProcedure, router } from "../trpc";
import { getDb } from "../db";
import { agents } from "../../db/schema";

export const agentsRouter = router({
  list: publicProcedure.query(() => {
    return getDb().select().from(agents).all();
  }),
});
