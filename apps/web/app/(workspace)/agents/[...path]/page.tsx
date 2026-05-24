import { getDb } from "@opencompany/db/client";
import { agents, brainFiles } from "@opencompany/db/schema";
import { and, asc, eq, or } from "drizzle-orm";
import { notFound } from "next/navigation";
import AgentDetail from "@/components/AgentDetail";
import { requireCurrentWorkspace } from "@/lib/auth";

export default async function AgentPage({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const idOrPath = path.map(decodeURIComponent).join("/");
  const { workspace } = await requireCurrentWorkspace();
  const db = getDb();

  const [agentRows, brainRows] = await Promise.all([
    db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspace.id),
          or(eq(agents.id, idOrPath), eq(agents.path, idOrPath)),
        ),
      )
      .limit(1),
    db
      .select({ path: brainFiles.path })
      .from(brainFiles)
      .where(eq(brainFiles.workspaceId, workspace.id))
      .orderBy(asc(brainFiles.path)),
  ]);
  const agent = agentRows[0];

  if (!agent) notFound();

  return (
    <AgentDetail
      id={agent.id}
      initialName={agent.name}
      initialBody={agent.body || agent.config.instructions}
      initialConfig={agent.config}
      initialPath={agent.path}
      initialGitHubCommitSha={agent.githubCommitSha}
      initialGitHubSyncedAt={agent.githubSyncedAt?.toISOString() ?? null}
      initialGitHubSyncStatus={agent.githubSyncStatus}
      initialGitHubSyncError={agent.githubSyncError}
      brainPaths={brainRows.map((row) => row.path)}
    />
  );
}
