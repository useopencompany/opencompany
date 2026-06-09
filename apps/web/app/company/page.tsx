import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import MainPanel from "@/components/MainPanel";
import SlackSupportCard from "@/components/SlackSupportCard";
import { currentWorkspace } from "@/lib/auth";

export default async function Home() {
  const context = await currentWorkspace();

  const db = getDb();
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      config: agents.config,
    })
    .from(agents)
    // Workspace-wide agents only; private/personal agents (userId set) are excluded.
    .where(and(eq(agents.workspaceId, context.workspace.id), isNull(agents.userId)))
    .orderBy(desc(agents.updatedAt));

  const agentOptions = rows.map((row) => ({
    id: row.id,
    name: row.name,
    defaultModel: row.config.model.name,
  }));

  return (
    <MainPanel
      agents={agentOptions}
      slackCard={<SlackSupportCard workspaceId={context.workspace.id} />}
    />
  );
}
