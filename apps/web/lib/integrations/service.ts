import { getDb } from "@opencompany/db/client";
import { workspaceIntegrationResources, workspaceIntegrations } from "@opencompany/db/schema";
import { and, eq, ne, notInArray } from "drizzle-orm";
import type { GitHubWorkRepository } from "@/lib/integrations/github";

export const GITHUB_INTEGRATION_PROVIDER = "github";
export const GITHUB_REPOSITORY_RESOURCE_TYPE = "repository";

export async function syncGitHubIntegrationRepositories(input: {
  workspaceId: string;
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
  repositories: GitHubWorkRepository[];
}) {
  const db = getDb();
  const now = new Date();

  const [integration] = await db
    .insert(workspaceIntegrations)
    .values({
      id: newWorkspaceIntegrationId(),
      workspaceId: input.workspaceId,
      provider: GITHUB_INTEGRATION_PROVIDER,
      externalId: input.installationId,
      accountName: input.accountLogin,
      accountType: input.accountType,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        workspaceIntegrations.workspaceId,
        workspaceIntegrations.provider,
        workspaceIntegrations.externalId,
      ],
      set: {
        accountName: input.accountLogin,
        accountType: input.accountType,
        updatedAt: now,
      },
    })
    .returning({ id: workspaceIntegrations.id });

  if (!integration) {
    throw new Error("Could not persist GitHub integration.");
  }

  for (const repository of input.repositories) {
    await db
      .insert(workspaceIntegrationResources)
      .values({
        id: newWorkspaceIntegrationResourceId(),
        workspaceId: input.workspaceId,
        integrationId: integration.id,
        provider: GITHUB_INTEGRATION_PROVIDER,
        resourceType: GITHUB_REPOSITORY_RESOURCE_TYPE,
        externalId: repository.githubRepoId,
        name: repository.fullName,
        displayName: repository.fullName,
        metadata: {
          defaultBranch: repository.defaultBranch,
          private: repository.private,
        },
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceIntegrationResources.workspaceId,
          workspaceIntegrationResources.provider,
          workspaceIntegrationResources.resourceType,
          workspaceIntegrationResources.externalId,
        ],
        set: {
          integrationId: integration.id,
          name: repository.fullName,
          displayName: repository.fullName,
          metadata: {
            defaultBranch: repository.defaultBranch,
            private: repository.private,
          },
          updatedAt: now,
        },
      });
  }

  if (input.repositories.length > 0) {
    await db.delete(workspaceIntegrationResources).where(
      and(
        eq(workspaceIntegrationResources.workspaceId, input.workspaceId),
        eq(workspaceIntegrationResources.provider, GITHUB_INTEGRATION_PROVIDER),
        eq(workspaceIntegrationResources.resourceType, GITHUB_REPOSITORY_RESOURCE_TYPE),
        notInArray(
          workspaceIntegrationResources.externalId,
          input.repositories.map((repository) => repository.githubRepoId),
        ),
      ),
    );
  } else {
    await db
      .delete(workspaceIntegrationResources)
      .where(
        and(
          eq(workspaceIntegrationResources.workspaceId, input.workspaceId),
          eq(workspaceIntegrationResources.provider, GITHUB_INTEGRATION_PROVIDER),
          eq(workspaceIntegrationResources.resourceType, GITHUB_REPOSITORY_RESOURCE_TYPE),
        ),
      );
  }

  await db
    .delete(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, input.workspaceId),
        eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
        ne(workspaceIntegrations.externalId, input.installationId),
      ),
    );
}

export async function disconnectGitHubIntegration(input: { workspaceId: string }) {
  const db = getDb();

  await db
    .delete(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, input.workspaceId),
        eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
      ),
    );
}

function newWorkspaceIntegrationId() {
  return `wint_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function newWorkspaceIntegrationResourceId() {
  return `wres_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
