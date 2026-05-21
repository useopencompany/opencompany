import { desc, eq } from "drizzle-orm";
import AgentsView from "@/components/AgentsView";
import AppShell from "@/components/AppShell";
import { getCurrentWorkspace } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents } from "@/lib/db/schema";

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
