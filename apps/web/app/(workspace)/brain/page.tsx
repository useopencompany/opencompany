import { getDb } from "@opencompany/db/client";
import { brainFiles } from "@opencompany/db/schema";
import { asc, eq } from "drizzle-orm";
import BrainView from "@/components/BrainView";
import { requireCurrentWorkspace } from "@/lib/auth";

export default async function BrainPage() {
  const { workspace } = await requireCurrentWorkspace();
  const files = await getDb()
    .select()
    .from(brainFiles)
    .where(eq(brainFiles.workspaceId, workspace.id))
    .orderBy(asc(brainFiles.path));

  return (
    <BrainView
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
