"use server";

import { getDb } from "@opencompany/db/client";
import { workspaceIntegrationResources, workspaceIntegrations } from "@opencompany/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentWorkspace } from "@/lib/auth";
import {
  deleteGitHubWorkInstallation,
  GitHubInstallationNotFoundError,
  getGitHubWorkInstallation,
  isGitHubWorkInstallationManagementConfigured,
  isGitHubWorkIntegrationConfigured,
  listGitHubWorkInstallationRepositories,
} from "@/lib/integrations/github";
import {
  disconnectGitHubIntegration,
  GITHUB_INTEGRATION_PROVIDER,
  GITHUB_REPOSITORY_RESOURCE_TYPE,
  markGitHubIntegrationStatus,
  syncGitHubIntegrationRepositories,
} from "@/lib/integrations/service";
import { githubStatus } from "@/lib/integrations/status";

export async function loadWorkspaceIntegrationState() {
  const { workspace } = await currentWorkspace();
  const db = getDb();
  const [connections, repositories] = await Promise.all([
    db
      .select()
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspace.id),
          eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
        ),
      )
      .orderBy(workspaceIntegrations.accountName, workspaceIntegrations.createdAt),
    db
      .select()
      .from(workspaceIntegrationResources)
      .where(
        and(
          eq(workspaceIntegrationResources.workspaceId, workspace.id),
          eq(workspaceIntegrationResources.provider, GITHUB_INTEGRATION_PROVIDER),
          eq(workspaceIntegrationResources.resourceType, GITHUB_REPOSITORY_RESOURCE_TYPE),
        ),
      ),
  ]);
  const repositoriesByIntegrationId = new Map<string, (typeof repositories)[number][]>();
  for (const repository of repositories) {
    const existing = repositoriesByIntegrationId.get(repository.integrationId) ?? [];
    existing.push(repository);
    repositoriesByIntegrationId.set(repository.integrationId, existing);
  }

  return {
    github: {
      status: githubStatus({
        configured: isGitHubWorkIntegrationConfigured(),
        connectionStatuses: connections.map((connection) => connection.status),
        availableRepositoryCount: repositories.filter(
          (repository) => repository.status === "available",
        ).length,
      }),
      connections: connections.map((connection) => {
        const connectionRepositories = repositoriesByIntegrationId.get(connection.id) ?? [];
        return {
          id: connection.id,
          installationId: connection.externalId,
          connectionLabel: connection.connectionLabel ?? connection.accountName ?? "GitHub",
          accountLogin: connection.accountName,
          accountType: connection.accountType,
          status: connection.status,
          statusReason: connection.statusReason,
          updatedAt: (connection.lastSyncedAt ?? connection.updatedAt).toISOString(),
          repositories: connectionRepositories
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((repository) => ({
              fullName: repository.name,
              defaultBranch: readGitHubRepositoryMetadata(repository.metadata).defaultBranch,
              status: repository.status,
              statusReason: repository.statusReason,
              lastSyncedAt: repository.lastSyncedAt?.toISOString() ?? null,
              selectedAt: repository.selectedAt?.toISOString() ?? null,
            })),
        };
      }),
    },
  };
}

export async function refreshGitHubRepositories(integrationId: string) {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  if (!isGitHubWorkIntegrationConfigured()) return;

  const db = getDb();
  const [existingInstallation] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspace.id),
        eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
        eq(workspaceIntegrations.id, integrationId),
      ),
    )
    .limit(1);

  if (!existingInstallation) {
    return;
  }

  try {
    const installationId = existingInstallation.externalId;
    const installation = await getGitHubWorkInstallation({ installationId });
    const repositories = await listGitHubWorkInstallationRepositories({ installationId });
    await syncGitHubIntegrationRepositories({
      workspaceId: workspace.id,
      installationId,
      accountLogin: installation.account?.login ?? existingInstallation.accountName,
      accountType: installation.account?.type ?? existingInstallation.accountType,
      repositories,
    });
  } catch (error) {
    await markGitHubIntegrationStatus({
      workspaceId: workspace.id,
      integrationId: existingInstallation.id,
      status: classifyGitHubSyncFailure(error),
      statusReason: error instanceof Error ? error.message : "GitHub refresh failed.",
    });
  }

  revalidateIntegrationPaths();
}

export async function markGitHubRepositorySelected(input: {
  integrationId: string;
  fullName: string;
}) {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  await getDb()
    .update(workspaceIntegrationResources)
    .set({ selectedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(workspaceIntegrationResources.workspaceId, workspace.id),
        eq(workspaceIntegrationResources.integrationId, input.integrationId),
        eq(workspaceIntegrationResources.provider, GITHUB_INTEGRATION_PROVIDER),
        eq(workspaceIntegrationResources.resourceType, GITHUB_REPOSITORY_RESOURCE_TYPE),
        eq(workspaceIntegrationResources.name, input.fullName),
      ),
    );

  revalidateIntegrationPaths();
}

export type DisconnectGitHubIntegrationResult = {
  ok: boolean;
  status: "disconnected" | "not_connected" | "error";
  message: string;
};

export async function disconnectGitHubIntegrationAction(
  integrationId: string,
): Promise<DisconnectGitHubIntegrationResult> {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  const db = getDb();
  const [existingInstallation] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspace.id),
        eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
        eq(workspaceIntegrations.id, integrationId),
      ),
    )
    .limit(1);

  if (!existingInstallation) {
    return {
      ok: true,
      status: "not_connected",
      message: "GitHub was already disconnected.",
    };
  }

  if (!isGitHubWorkInstallationManagementConfigured()) {
    await disconnectGitHubIntegration({ workspaceId: workspace.id, integrationId });
    revalidateIntegrationPaths();
    return {
      ok: true,
      status: "disconnected",
      message:
        "Removed the local GitHub connection. GitHub App credentials are not configured for uninstall.",
    };
  }

  const [sharedInstallation] = await db
    .select({ workspaceId: workspaceIntegrations.workspaceId })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
        eq(workspaceIntegrations.externalId, existingInstallation.externalId),
        ne(workspaceIntegrations.workspaceId, workspace.id),
      ),
    )
    .limit(1);

  if (!sharedInstallation) {
    try {
      await deleteGitHubWorkInstallation({ installationId: existingInstallation.externalId });
    } catch (error) {
      if (!(error instanceof GitHubInstallationNotFoundError)) {
        return {
          ok: false,
          status: "error",
          message:
            error instanceof Error ? error.message : "GitHub could not be disconnected. Try again.",
        };
      }
    }
  }

  await disconnectGitHubIntegration({ workspaceId: workspace.id, integrationId });
  revalidateIntegrationPaths();

  return {
    ok: true,
    status: "disconnected",
    message: sharedInstallation
      ? "GitHub was disconnected from this workspace. The GitHub App remains installed because another workspace still uses it."
      : "GitHub was disconnected from this workspace.",
  };
}

function classifyGitHubSyncFailure(error: unknown): "needs_reauth" | "sync_failed" {
  if (error instanceof GitHubInstallationNotFoundError) return "needs_reauth";
  const message = error instanceof Error ? error.message : "";
  return /\b(401|403|404)\b/.test(message) ? "needs_reauth" : "sync_failed";
}

function readGitHubRepositoryMetadata(metadata: Record<string, unknown>) {
  return {
    defaultBranch:
      typeof metadata.defaultBranch === "string" && metadata.defaultBranch.trim()
        ? metadata.defaultBranch.trim()
        : "main",
  };
}

function revalidateIntegrationPaths() {
  revalidatePath("/agents");
  revalidatePath("/settings");
  revalidatePath("/settings/integrations");
}
