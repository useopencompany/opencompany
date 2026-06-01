"use server";

import { agentBundleDir } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agentFiles, agents } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  type AgentBundleFilePayload,
  isAgentBundleTextFile,
  normalizeAgentBundleRelativePath,
  serializeAgentBundleFiles,
} from "@/lib/agents/bundle-files";
import { scheduleAgentFileSyncDispatch } from "@/lib/agents/file-sync-dispatch";
import { agentFileSyncJobUpsert } from "@/lib/agents/sync-job";
import { currentWorkspace } from "@/lib/auth";
import { brainContentSize, hashBrainContent } from "@/lib/brain/hash";
import { MAX_BRAIN_FILE_BYTES } from "@/lib/brain/paths";

type AgentBundleFileActionResult =
  | { ok: true; file: AgentBundleFilePayload }
  | { ok: false; error: string };

export async function updateAgentBundleFile(
  agentId: string,
  path: string,
  content: string,
): Promise<AgentBundleFileActionResult> {
  const { workspace } = await currentWorkspace();
  const db = getDb();

  try {
    const [agent] = await db
      .select({ id: agents.id, path: agents.path })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspace.id)))
      .limit(1);
    if (!agent?.path) return { ok: false, error: "Agent not found." };

    const bundleDir = agentBundleDir(agent.path);
    const prefix = `${bundleDir}/`;
    if (!path.startsWith(prefix)) {
      return { ok: false, error: "Bundle file is outside this agent." };
    }

    const relativePath = normalizeAgentBundleRelativePath(path.slice(prefix.length));
    if (!relativePath || relativePath === "agent.agent") {
      return { ok: false, error: "Bundle file path is invalid." };
    }
    if (!isAgentBundleTextFile(relativePath)) {
      return { ok: false, error: "Only text bundle files are supported." };
    }

    const normalizedPath = `${bundleDir}/${relativePath}`;
    const sizeBytes = brainContentSize(content);
    if (sizeBytes > MAX_BRAIN_FILE_BYTES) {
      return { ok: false, error: "Agent bundle files must be 256 KB or smaller." };
    }

    const [existing] = await db
      .select()
      .from(agentFiles)
      .where(
        and(
          eq(agentFiles.workspaceId, workspace.id),
          eq(agentFiles.agentId, agent.id),
          eq(agentFiles.path, normalizedPath),
        ),
      )
      .limit(1);
    if (!existing) return { ok: false, error: "Bundle file not found." };

    const contentHash = hashBrainContent(content);
    const now = new Date();
    await db.batch([
      db
        .update(agentFiles)
        .set({
          content,
          contentHash,
          sizeBytes,
          githubSyncStatus: "pending",
          githubSyncError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentFiles.workspaceId, workspace.id),
            eq(agentFiles.agentId, agent.id),
            eq(agentFiles.path, normalizedPath),
          ),
        ),
      agentFileSyncJobUpsert(db, {
        workspaceId: workspace.id,
        path: normalizedPath,
        operation: "upsert",
        desiredHash: contentHash,
      }),
    ]);

    scheduleAgentFileSyncDispatch({ workspaceId: workspace.id, path: normalizedPath });
    revalidatePath(`/agents/${agent.path}`);
    revalidatePath(`/agents/${agent.id}`);

    const [updated] = await db
      .select()
      .from(agentFiles)
      .where(
        and(
          eq(agentFiles.workspaceId, workspace.id),
          eq(agentFiles.agentId, agent.id),
          eq(agentFiles.path, normalizedPath),
        ),
      )
      .limit(1);
    const [file] = serializeAgentBundleFiles(agent.path, updated ? [updated] : []);
    if (!file) return { ok: false, error: "Bundle file not found after save." };
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Save failed." };
  }
}
