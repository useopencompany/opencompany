import { getDb } from "@opencompany/db/client";
import { brainFiles } from "@opencompany/db/schema";
import { asc, eq } from "drizzle-orm";
import BrainView from "@/components/BrainView";
import { currentWorkspace } from "@/lib/auth";

export default async function BrainPage({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  const initialPath = (path ?? []).map(decodeURIComponent).join("/");
  const { workspace } = await currentWorkspace();
  const files = await getDb()
    .select()
    .from(brainFiles)
    .where(eq(brainFiles.workspaceId, workspace.id))
    .orderBy(asc(brainFiles.path));

  return (
    <BrainView
      initialPath={initialPath}
      files={files.map((file) => ({
        path: file.path,
        content: file.content,
        sizeBytes: file.sizeBytes,
        contentHash: file.contentHash,
        githubCommitSha: file.githubCommitSha,
        githubSyncedAt: file.githubSyncedAt?.toISOString() ?? null,
        githubSyncStatus: file.githubSyncStatus,
        githubSyncError: file.githubSyncError,
        updatedAt: file.updatedAt.toISOString(),
      }))}
    />
  );
}
