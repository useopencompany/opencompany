import { getDb } from "@opencompany/db/client";
import { agentFiles } from "@opencompany/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { type PersonalBrainFile, requirePersonalAgentRef } from "@/lib/personal/brain";

// Memory is the personal agent's own auto-distilled understanding — what it has learned about the
// user — maintained by the memory tool (never edited by hand). It lives inside the agent's bundle
// under a dedicated `memory/` subfolder (agent_files, scoped per agent), so it is automatically
// per-user and local-only. Distinct from Personal Brain (user-authored, `personal-brain/`). The UI
// surfaces it read-only, so we reuse PersonalBrainFile's shape with inert GitHub-sync fields.
export const PERSONAL_MEMORY_SUBDIR = "memory";

export function personalMemoryPrefix(bundleDir: string): string {
  return `${bundleDir}/${PERSONAL_MEMORY_SUBDIR}/`;
}

// Load the personal agent's Memory files as logical (prefix-stripped) paths. Mirrors
// loadPersonalBrainFiles, swapping the bundle subtree.
export async function loadPersonalMemoryFiles(): Promise<PersonalBrainFile[]> {
  const ref = await requirePersonalAgentRef();
  const prefix = personalMemoryPrefix(ref.bundleDir);
  const rows = await getDb()
    .select()
    .from(agentFiles)
    .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.agentId, ref.agentId)))
    .orderBy(asc(agentFiles.path));

  return rows
    .filter((row) => row.path.startsWith(prefix))
    .map((row) => ({
      id: row.id,
      repoPath: row.path,
      path: row.path.slice(prefix.length),
      content: row.content,
      sizeBytes: row.sizeBytes,
      contentHash: row.contentHash,
      githubCommitSha: null,
      githubSyncedAt: null,
      githubSyncStatus: "synced",
      githubSyncError: null,
      updatedAt: row.updatedAt.toISOString(),
    }));
}
