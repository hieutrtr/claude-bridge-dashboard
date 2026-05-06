// T5 — root tRPC appRouter. Six routers planned in ARCHITECTURE.md §4
// (`agents`, `tasks`, `loops`, `schedules`, `analytics`, `auth`).
// Phase 0 shipped `agents`; T04 adds the `tasks` router (only the
// `listByAgent` query — read-only). Phase 2 T06 adds `loops` (only
// `approve` / `reject` mutations — list / get / start / cancel land
// in Phase 3 with the `/loops` page). Schedules / auth land later.

import { router } from "../trpc";
import { agentsRouter } from "./agents";
import { analyticsRouter } from "./analytics";
import { auditRouter } from "./audit";
import { authRouter } from "./auth";
import { loopsRouter } from "./loops";
import { permissionsRouter } from "./permissions";
import { schedulesRouter } from "./schedules";
import { tasksRouter } from "./tasks";

export const appRouter = router({
  agents: agentsRouter,
  analytics: analyticsRouter,
  audit: auditRouter,
  auth: authRouter,
  loops: loopsRouter,
  permissions: permissionsRouter,
  schedules: schedulesRouter,
  tasks: tasksRouter,
});

export type AppRouter = typeof appRouter;
