import { agentBundleDir } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agentFiles, agents } from "@opencompany/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";

// Personal Brain is the user's private, persistent knowledge space. It is stored inside the personal
// agent's bundle under a dedicated `personal-brain/` subfolder (agent_files, scoped per agent), so it
// is automatically per-user and local-only (never projected to GitHub) — distinct from the
// workspace Brain (brainFiles) and from Memory (the agent's tool-managed distilled understanding).
export const PERSONAL_BRAIN_SUBDIR = "personal-brain";

// The shape BrainView consumes. Personal Brain files are local-only, so the GitHub sync fields are
// inert (synced / null) — BrainView simply never shows a pending-sync state for them.
export type PersonalBrainFile = {
  path: string;
  content: string;
  sizeBytes: number;
  contentHash: string;
  githubCommitSha: string | null;
  githubSyncedAt: string | null;
  githubSyncStatus: string;
  githubSyncError: string | null;
  updatedAt: string;
};

export type PersonalAgentRef = {
  workspaceId: string;
  agentId: string;
  bundleDir: string;
};

// Resolve the caller's default personal agent. The /personal layout calls ensurePersonalAgent before
// any of these surfaces render, so the row exists by the time an action runs.
export async function requirePersonalAgentRef(): Promise<PersonalAgentRef> {
  const { workspace, user } = await currentWorkspace();
  const [agent] = await getDb()
    .select({ id: agents.id, path: agents.path })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspace.id),
        eq(agents.userId, user.id),
        eq(agents.isDefault, true),
      ),
    )
    .limit(1);
  if (!agent?.path) {
    throw new Error("Personal agent is not provisioned yet.");
  }
  return { workspaceId: workspace.id, agentId: agent.id, bundleDir: agentBundleDir(agent.path) };
}

// The full agent_files repo path for a logical Brain path (e.g. "notes.md" → "agents/<slug>/
// personal-brain/notes.md").
export function personalBrainRepoPath(bundleDir: string, logicalPath: string): string {
  return `${bundleDir}/${PERSONAL_BRAIN_SUBDIR}/${logicalPath}`;
}

// The prefix every Personal Brain file shares, used to list + strip back to logical paths.
export function personalBrainPrefix(bundleDir: string): string {
  return `${bundleDir}/${PERSONAL_BRAIN_SUBDIR}/`;
}

// Load the personal agent's Brain files as logical (prefix-stripped) paths for BrainView.
export async function loadPersonalBrainFiles(): Promise<PersonalBrainFile[]> {
  const ref = await requirePersonalAgentRef();
  const prefix = personalBrainPrefix(ref.bundleDir);
  const rows = await getDb()
    .select()
    .from(agentFiles)
    .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.agentId, ref.agentId)))
    .orderBy(asc(agentFiles.path));

  return rows
    .filter((row) => row.path.startsWith(prefix))
    .map((row) => ({
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
