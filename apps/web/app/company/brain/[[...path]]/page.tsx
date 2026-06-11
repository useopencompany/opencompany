import { getDb } from "@opencompany/db/client";
import { brainFiles } from "@opencompany/db/schema";
import { asc, eq } from "drizzle-orm";
import BrainView from "@/components/BrainView";
import { currentWorkspace } from "@/lib/auth";
import { BRAIN_BASE_PATH } from "@/lib/brain/paths";

// Decodes a single path segment, falling back to the raw value when the segment carries a malformed
// percent-encoding (e.g. a bare `%`) so a bad URL never throws a URIError before the page renders.
function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export default async function BrainPage({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  const initialPath = (path ?? []).map(safeDecodeSegment).join("/");
  const { workspace } = await currentWorkspace();
  const files = await getDb()
    .select()
    .from(brainFiles)
    .where(eq(brainFiles.workspaceId, workspace.id))
    .orderBy(asc(brainFiles.path));

  return (
    <BrainView
      initialPath={initialPath}
      urlBasePath={BRAIN_BASE_PATH}
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
