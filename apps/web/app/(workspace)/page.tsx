import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { desc, eq } from "drizzle-orm";
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
    })
    .from(agents)
    .where(eq(agents.workspaceId, context.workspace.id))
    .orderBy(desc(agents.updatedAt));

  return (
    <MainPanel agents={rows} slackCard={<SlackSupportCard workspaceId={context.workspace.id} />} />
  );
}
