"use server";

import { getDb } from "@opencompany/db/client";
import {
  workspaceGitHubIntegrationInstallations,
  workspaceGitHubIntegrationRepositories,
} from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getCurrentWorkspace, requireCurrentWorkspace } from "@/lib/auth";
import {
  getGitHubWorkInstallation,
  isGitHubWorkIntegrationConfigured,
  listGitHubWorkInstallationRepositories,
} from "@/lib/integrations/github";
import { syncGitHubIntegrationRepositories } from "@/lib/integrations/service";

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
      .from(workspaceGitHubIntegrationInstallations)
      .where(eq(workspaceGitHubIntegrationInstallations.workspaceId, workspace.id))
      .limit(1),
    db
      .select()
      .from(workspaceGitHubIntegrationRepositories)
      .where(eq(workspaceGitHubIntegrationRepositories.workspaceId, workspace.id)),
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
            installationId: installation[0].installationId,
            accountLogin: installation[0].accountLogin,
            accountType: installation[0].accountType,
            updatedAt: installation[0].updatedAt.toISOString(),
          }
        : null,
      repositories: repositories
        .sort((left, right) => left.fullName.localeCompare(right.fullName))
        .map((repository) => ({
          fullName: repository.fullName,
          defaultBranch: repository.defaultBranch,
          selectedAt: repository.selectedAt?.toISOString() ?? null,
        })),
    },
  };
}

export async function refreshGitHubRepositories() {
  const { workspace } = await getCurrentWorkspace();
  if (!isGitHubWorkIntegrationConfigured()) return;

  const db = getDb();
  const [existingInstallation] = await db
    .select()
    .from(workspaceGitHubIntegrationInstallations)
    .where(eq(workspaceGitHubIntegrationInstallations.workspaceId, workspace.id))
    .limit(1);

  if (!existingInstallation) {
    return;
  }

  const installationId = existingInstallation.installationId;
  const installation = await getGitHubWorkInstallation({ installationId });
  const repositories = await listGitHubWorkInstallationRepositories({ installationId });
  await syncGitHubIntegrationRepositories({
    workspaceId: workspace.id,
    installationId,
    accountLogin: installation.account?.login ?? existingInstallation.accountLogin,
    accountType: installation.account?.type ?? existingInstallation.accountType,
    repositories,
  });

  revalidateIntegrationPaths();
}

export async function markGitHubRepositorySelected(fullName: string) {
  const { workspace } = await getCurrentWorkspace();
  await getDb()
    .update(workspaceGitHubIntegrationRepositories)
    .set({ selectedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(workspaceGitHubIntegrationRepositories.workspaceId, workspace.id),
        eq(workspaceGitHubIntegrationRepositories.fullName, fullName),
      ),
    );

  revalidateIntegrationPaths();
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

function revalidateIntegrationPaths() {
  revalidatePath("/agents");
  revalidatePath("/settings");
  revalidatePath("/settings/integrations");
}
