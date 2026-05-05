// T5 — /agents page. React Server Component that calls the tRPC procedure
// in-process via createCaller (no HTTP roundtrip) and hands the rows to the
// pure AgentsTable component.

import { appRouter } from "../../src/server/routers/_app";
import { AgentsTable } from "../../src/components/agents-table";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const caller = appRouter.createCaller({});
  const agents = await caller.agents.list();
  return (
    <main>
      <h1>Agents</h1>
      <AgentsTable agents={agents} />
    </main>
  );
}
