import { getDb } from "@opencompany/db/client";
import { agents, brainFiles, workspaceIntegrationResources } from "@opencompany/db/schema";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { type AgentPayload, serializeAgent } from "@/lib/agents/payload";
import {
  GITHUB_INTEGRATION_PROVIDER,
  GITHUB_REPOSITORY_RESOURCE_TYPE,
} from "@/lib/integrations/service";

async function loadBrainPathsForWorkspace(workspaceId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ path: brainFiles.path })
    .from(brainFiles)
    .where(eq(brainFiles.workspaceId, workspaceId))
    .orderBy(asc(brainFiles.path));
  return rows.map((row) => row.path);
}

async function loadGitHubIntegrationRepositoriesForWorkspace(
  workspaceId: string,
): Promise<Array<{ fullName: string; defaultBranch: string }>> {
  const db = getDb();
  const rows = await db
    .select({
      fullName: workspaceIntegrationResources.name,
      metadata: workspaceIntegrationResources.metadata,
    })
    .from(workspaceIntegrationResources)
    .where(
      and(
        eq(workspaceIntegrationResources.workspaceId, workspaceId),
        eq(workspaceIntegrationResources.provider, GITHUB_INTEGRATION_PROVIDER),
        eq(workspaceIntegrationResources.resourceType, GITHUB_REPOSITORY_RESOURCE_TYPE),
      ),
    )
    .orderBy(asc(workspaceIntegrationResources.name));

  return rows.map((row) => ({
    fullName: row.fullName,
    defaultBranch: readGitHubRepositoryDefaultBranch(row.metadata),
  }));
}

export async function loadAgentsForWorkspace(workspaceId: string): Promise<AgentPayload[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(desc(agents.updatedAt));

  return rows.map((row) => serializeAgent(row));
}

export async function loadAgentForWorkspace(
  workspaceId: string,
  idOrPath: string,
): Promise<AgentPayload | null> {
  const db = getDb();
  const [[agent], brainPaths, githubIntegrationRepositories] = await Promise.all([
    db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          or(eq(agents.id, idOrPath), eq(agents.path, idOrPath)),
        ),
      )
      .limit(1),
    loadBrainPathsForWorkspace(workspaceId),
    loadGitHubIntegrationRepositoriesForWorkspace(workspaceId),
  ]);

  return agent ? serializeAgent(agent, brainPaths, githubIntegrationRepositories) : null;
}

function readGitHubRepositoryDefaultBranch(metadata: Record<string, unknown>) {
  return typeof metadata.defaultBranch === "string" && metadata.defaultBranch.trim()
    ? metadata.defaultBranch.trim()
    : "main";
}
