// T03 — /agents page. React Server Component that calls the tRPC
// procedure in-process via createCaller (no HTTP roundtrip) and hands
// the rows to the pure AgentsGrid component.

import { appRouter } from "@/src/server/routers/_app";
import { getSessionSubject } from "@/src/server/session";
import { AgentsGrid } from "@/src/components/agents-grid";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const userId = await getSessionSubject();
  const caller = appRouter.createCaller({ userId });
  const agents = await caller.agents.list();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Agents</h1>
      <AgentsGrid agents={agents} />
    </div>
  );
}
