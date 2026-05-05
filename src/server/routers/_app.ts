// T5 — root tRPC appRouter. Six routers planned in ARCHITECTURE.md §4
// (`agents`, `tasks`, `loops`, `schedules`, `analytics`, `auth`).
// Phase 0 shipped `agents`; T04 adds the `tasks` router (only the
// `listByAgent` query — read-only). Loops / schedules / analytics / auth
// land in later phases.

import { router } from "../trpc";
import { agentsRouter } from "./agents";
import { analyticsRouter } from "./analytics";
import { tasksRouter } from "./tasks";

export const appRouter = router({
  agents: agentsRouter,
  analytics: analyticsRouter,
  tasks: tasksRouter,
});

export type AppRouter = typeof appRouter;
