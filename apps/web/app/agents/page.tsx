import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { desc, eq } from "drizzle-orm";
import AgentsView from "@/components/AgentsView";
import AppShell from "@/components/AppShell";
import { getCurrentWorkspace } from "@/lib/auth";

export default async function AgentsPage() {
  const { workspace } = await getCurrentWorkspace();
  const db = getDb();

  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, workspace.id))
    .orderBy(desc(agents.updatedAt));

  return (
    <AppShell>
      <AgentsView agents={rows} />
    </AppShell>
  );
}
