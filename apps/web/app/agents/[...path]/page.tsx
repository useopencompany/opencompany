import { and, eq, or } from "drizzle-orm";
import { notFound } from "next/navigation";
import AppShell from "@/components/AppShell";
import AgentDetail from "@/components/AgentDetail";
import { getCurrentWorkspace } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents } from "@/lib/db/schema";

export default async function AgentPage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  const idOrPath = path.map(decodeURIComponent).join("/");
  const { workspace } = await getCurrentWorkspace();
  const db = getDb();

  const [agent] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspace.id),
        or(eq(agents.id, idOrPath), eq(agents.path, idOrPath)),
      ),
    )
    .limit(1);

  if (!agent) notFound();

  return (
    <AppShell>
      <AgentDetail
        id={agent.path ?? agent.id}
        initialName={agent.name}
        initialBody={agent.body || agent.config.instructions}
        initialGitHubSyncStatus={agent.githubSyncStatus}
        initialGitHubSyncError={agent.githubSyncError}
      />
    </AppShell>
  );
}
