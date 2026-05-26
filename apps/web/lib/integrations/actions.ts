"use server";

import { getDb } from "@opencompany/db/client";
import { workspaceIntegrationResources, workspaceIntegrations } from "@opencompany/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCurrentWorkspace, requireCurrentWorkspaceAdmin } from "@/lib/auth";
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
  syncGitHubIntegrationRepositories,
} from "@/lib/integrations/service";

export type WorkspaceIntegrationStatus =
  | "not_connected"
  | "connected"
  | "needs_repository_access"
  | "error";

export async function loadWorkspaceIntegrationState() {
  const { workspace } = await requireCurrentWorkspace();
  const db = getDb();
  const [installation, repositories] = await Promise.all([
    db
      .select()
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspace.id),
          eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
        ),
      )
      .limit(1),
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

  return {
    github: {
      status: githubStatus({
        configured: isGitHubWorkIntegrationConfigured(),
        hasInstallation: Boolean(installation[0]),
        repositoryCount: repositories.length,
      }),
      installation: installation[0]
        ? {
            installationId: installation[0].externalId,
            accountLogin: installation[0].accountName,
            accountType: installation[0].accountType,
            updatedAt: installation[0].updatedAt.toISOString(),
          }
        : null,
      repositories: repositories
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((repository) => ({
          fullName: repository.name,
          defaultBranch: readGitHubRepositoryMetadata(repository.metadata).defaultBranch,
          selectedAt: repository.selectedAt?.toISOString() ?? null,
        })),
    },
  };
}

export async function refreshGitHubRepositories() {
  const { workspace } = await requireCurrentWorkspaceAdmin();
  if (!isGitHubWorkIntegrationConfigured()) return;

  const db = getDb();
  const [existingInstallation] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspace.id),
        eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
      ),
    )
    .limit(1);

  if (!existingInstallation) {
    return;
  }

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

  revalidateIntegrationPaths();
}

export async function markGitHubRepositorySelected(fullName: string) {
  const { workspace } = await requireCurrentWorkspaceAdmin();
  await getDb()
    .update(workspaceIntegrationResources)
    .set({ selectedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(workspaceIntegrationResources.workspaceId, workspace.id),
        eq(workspaceIntegrationResources.provider, GITHUB_INTEGRATION_PROVIDER),
        eq(workspaceIntegrationResources.resourceType, GITHUB_REPOSITORY_RESOURCE_TYPE),
        eq(workspaceIntegrationResources.name, fullName),
      ),
    );

  revalidateIntegrationPaths();
}

export type DisconnectGitHubIntegrationResult = {
  ok: boolean;
  status: "disconnected" | "not_connected" | "error";
  message: string;
};

export async function disconnectGitHubIntegrationAction(): Promise<DisconnectGitHubIntegrationResult> {
  const { workspace } = await requireCurrentWorkspaceAdmin();
  const db = getDb();
  const [existingInstallation] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspace.id),
        eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
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
    await disconnectGitHubIntegration({ workspaceId: workspace.id });
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

  await disconnectGitHubIntegration({ workspaceId: workspace.id });
  revalidateIntegrationPaths();

  return {
    ok: true,
    status: "disconnected",
    message: sharedInstallation
      ? "GitHub was disconnected from this workspace. The GitHub App remains installed because another workspace still uses it."
      : "GitHub was disconnected from this workspace.",
  };
}

function githubStatus(input: {
  configured: boolean;
  hasInstallation: boolean;
  repositoryCount: number;
}): WorkspaceIntegrationStatus {
  if (!input.configured) return "error";
  if (!input.hasInstallation) return "not_connected";
  if (input.repositoryCount === 0) return "needs_repository_access";
  return "connected";
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
