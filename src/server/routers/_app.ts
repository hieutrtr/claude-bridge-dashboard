// T5 — root tRPC appRouter. Six routers planned in ARCHITECTURE.md §4
// (`agents`, `tasks`, `loops`, `schedules`, `analytics`, `auth`); only
// `agents` lands in Phase 0.

import { router } from "../trpc";
import { agentsRouter } from "./agents";

export const appRouter = router({
  agents: agentsRouter,
});

export type AppRouter = typeof appRouter;
