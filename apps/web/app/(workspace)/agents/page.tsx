import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { desc, eq } from "drizzle-orm";
import AgentsView from "@/components/AgentsView";
import { requireCurrentWorkspace } from "@/lib/auth";

export default async function AgentsPage() {
  const { workspace } = await requireCurrentWorkspace();
  const db = getDb();

  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, workspace.id))
    .orderBy(desc(agents.updatedAt));

  return <AgentsView agents={rows} />;
}
