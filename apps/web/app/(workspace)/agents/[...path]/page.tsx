import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { and, eq, or } from "drizzle-orm";
import { notFound } from "next/navigation";
import AgentDetail from "@/components/AgentDetail";
import { requireCurrentWorkspace } from "@/lib/auth";

export default async function AgentPage({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const idOrPath = path.map(decodeURIComponent).join("/");
  const { workspace } = await requireCurrentWorkspace();
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
    <AgentDetail
      id={agent.path ?? agent.id}
      initialName={agent.name}
      initialBody={agent.body || agent.config.instructions}
      initialConfig={agent.config}
      initialPath={agent.path}
      initialGitHubCommitSha={agent.githubCommitSha}
      initialGitHubSyncedAt={agent.githubSyncedAt?.toISOString() ?? null}
      initialGitHubSyncStatus={agent.githubSyncStatus}
      initialGitHubSyncError={agent.githubSyncError}
    />
  );
}
