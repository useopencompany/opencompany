import { getDb } from "@opencompany/db/client";
import {
  agents,
  brainFiles,
  workspaceIntegrationResources,
  workspaceIntegrations,
} from "@opencompany/db/schema";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { loadAgentSessionSummariesForWorkspace } from "@/lib/agent-sessions/data";
import {
  type AgentDetailPayload,
  type AgentListItemPayload,
  buildGitHubRepositoryCatalogs,
  type GitHubIntegrationRepositoryPayload,
  serializeAgentDetail,
  serializeAgentListItem,
} from "@/lib/agents/payload";
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
): Promise<GitHubIntegrationRepositoryPayload[]> {
  const db = getDb();
  const rows = await db
    .select({
      fullName: workspaceIntegrationResources.name,
      externalId: workspaceIntegrationResources.externalId,
      displayName: workspaceIntegrationResources.displayName,
      status: workspaceIntegrationResources.status,
      statusReason: workspaceIntegrationResources.statusReason,
      lastSyncedAt: workspaceIntegrationResources.lastSyncedAt,
      metadata: workspaceIntegrationResources.metadata,
      connectionExternalId: workspaceIntegrations.externalId,
      connectionLabel: workspaceIntegrations.connectionLabel,
      accountName: workspaceIntegrations.accountName,
      accountType: workspaceIntegrations.accountType,
      connectionStatus: workspaceIntegrations.status,
    })
    .from(workspaceIntegrationResources)
    .innerJoin(
      workspaceIntegrations,
      eq(workspaceIntegrationResources.integrationId, workspaceIntegrations.id),
    )
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
    status: row.status,
    statusReason: row.statusReason,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    connectionStatus: row.connectionStatus,
    binding: {
      provider: "github",
      resourceType: "repository",
      externalId: row.externalId,
      displayName: row.displayName ?? row.fullName,
      connection: {
        externalId: row.connectionExternalId,
        label: row.connectionLabel ?? row.accountName ?? "GitHub",
        accountName: row.accountName,
        accountType: row.accountType,
      },
    },
  }));
}

export async function loadAgentsForWorkspace(workspaceId: string): Promise<AgentListItemPayload[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(desc(agents.updatedAt));

  return rows.map((row) => serializeAgentListItem(row));
}

export async function loadAgentForWorkspace(
  workspaceId: string,
  idOrPath: string,
  options?: { userId?: string; canViewWorkspaceSessions?: boolean },
): Promise<AgentDetailPayload | null> {
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

  if (!agent) return null;

  const { derivationRepositories, usableRepositories } = buildGitHubRepositoryCatalogs({
    repositories: githubIntegrationRepositories,
    savedRepositories: agent.config.integrations.github.repositories,
  });
  const sessions = options?.userId
    ? await loadAgentSessionSummariesForWorkspace({
        agentId: agent.id,
        userId: options.userId,
        workspaceId,
        canViewWorkspaceSessions: options.canViewWorkspaceSessions ?? false,
      })
    : [];

  return serializeAgentDetail(
    agent,
    brainPaths,
    derivationRepositories,
    usableRepositories,
    sessions,
  );
}

function readGitHubRepositoryDefaultBranch(metadata: Record<string, unknown>) {
  return typeof metadata.defaultBranch === "string" && metadata.defaultBranch.trim()
    ? metadata.defaultBranch.trim()
    : "main";
}
