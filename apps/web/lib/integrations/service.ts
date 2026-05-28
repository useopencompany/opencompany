import { getDb } from "@opencompany/db/client";
import {
  type WorkspaceIntegrationConnectionStatus,
  workspaceIntegrationResources,
  workspaceIntegrations,
} from "@opencompany/db/schema";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { saveIntegrationCredential } from "@/lib/integrations/credential-storage";
import type { GitHubWorkRepository } from "@/lib/integrations/github";
import { sanitizeIntegrationStatusReason } from "@/lib/integrations/status";

export const GITHUB_INTEGRATION_PROVIDER = "github";
export const GITHUB_REPOSITORY_RESOURCE_TYPE = "repository";

export async function syncGitHubIntegrationRepositories(input: {
  workspaceId: string;
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
  connectedByUserId?: string;
  repositories: GitHubWorkRepository[];
  userOAuthToken?: string;
}) {
  const db = getDb();
  const now = new Date();
  const connectionLabel = input.accountLogin?.trim() || "GitHub";
  const integrationUpdate = {
    connectionLabel,
    accountName: input.accountLogin,
    accountType: input.accountType,
    status: "connected" as const,
    statusReason: null,
    lastSyncedAt: now,
    updatedAt: now,
    ...(input.connectedByUserId ? { connectedByUserId: input.connectedByUserId } : {}),
  };

  const [integration] = await db
    .insert(workspaceIntegrations)
    .values({
      id: newWorkspaceIntegrationId(),
      workspaceId: input.workspaceId,
      provider: GITHUB_INTEGRATION_PROVIDER,
      externalId: input.installationId,
      connectionLabel,
      accountName: input.accountLogin,
      accountEmail: null,
      accountType: input.accountType,
      connectedByUserId: input.connectedByUserId ?? null,
      status: "connected",
      statusReason: null,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        workspaceIntegrations.workspaceId,
        workspaceIntegrations.provider,
        workspaceIntegrations.externalId,
      ],
      set: integrationUpdate,
    })
    .returning({ id: workspaceIntegrations.id });

  if (!integration) {
    throw new Error("Could not persist GitHub integration.");
  }

  if (input.userOAuthToken) {
    await saveIntegrationCredential({
      workspaceId: input.workspaceId,
      integrationId: integration.id,
      provider: GITHUB_INTEGRATION_PROVIDER,
      kind: "oauth_token",
      payload: { accessToken: input.userOAuthToken },
      db,
      now,
    });
  }

  const resourceValues = input.repositories.map((repository) => ({
    id: newWorkspaceIntegrationResourceId(),
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    provider: GITHUB_INTEGRATION_PROVIDER,
    resourceType: GITHUB_REPOSITORY_RESOURCE_TYPE,
    externalId: repository.githubRepoId,
    name: repository.fullName,
    displayName: repository.fullName,
    status: "available" as const,
    statusReason: null,
    lastSyncedAt: now,
    metadata: {
      defaultBranch: repository.defaultBranch,
      private: repository.private,
    },
    updatedAt: now,
  }));

  if (resourceValues.length > 0) {
    await db
      .insert(workspaceIntegrationResources)
      .values(resourceValues)
      .onConflictDoUpdate({
        target: [
          workspaceIntegrationResources.integrationId,
          workspaceIntegrationResources.resourceType,
          workspaceIntegrationResources.externalId,
        ],
        set: {
          workspaceId: input.workspaceId,
          integrationId: integration.id,
          provider: GITHUB_INTEGRATION_PROVIDER,
          resourceType: GITHUB_REPOSITORY_RESOURCE_TYPE,
          name: sql`excluded.name`,
          displayName: sql`excluded.display_name`,
          status: "available",
          statusReason: null,
          lastSyncedAt: now,
          metadata: sql`excluded.metadata`,
          updatedAt: now,
        },
      });
  }

  const staleResourceUpdate = {
    status: "permission_lost" as const,
    statusReason: "Repository is no longer visible to the GitHub installation.",
    lastSyncedAt: now,
    updatedAt: now,
  };

  if (input.repositories.length > 0) {
    await db
      .update(workspaceIntegrationResources)
      .set(staleResourceUpdate)
      .where(
        and(
          eq(workspaceIntegrationResources.integrationId, integration.id),
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
      .update(workspaceIntegrationResources)
      .set(staleResourceUpdate)
      .where(
        and(
          eq(workspaceIntegrationResources.integrationId, integration.id),
          eq(workspaceIntegrationResources.workspaceId, input.workspaceId),
          eq(workspaceIntegrationResources.provider, GITHUB_INTEGRATION_PROVIDER),
          eq(workspaceIntegrationResources.resourceType, GITHUB_REPOSITORY_RESOURCE_TYPE),
        ),
      );
  }
}

export async function markGitHubIntegrationStatus(input: {
  workspaceId: string;
  integrationId: string;
  status: Extract<WorkspaceIntegrationConnectionStatus, "needs_reauth" | "sync_failed">;
  statusReason: string;
}) {
  const now = new Date();
  await getDb()
    .update(workspaceIntegrations)
    .set({
      status: input.status,
      statusReason: sanitizeIntegrationStatusReason(input.statusReason, "GitHub sync failed."),
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, input.workspaceId),
        eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
        eq(workspaceIntegrations.id, input.integrationId),
      ),
    );
}

export async function disconnectGitHubIntegration(input: {
  workspaceId: string;
  integrationId: string;
}) {
  const db = getDb();

  await db
    .delete(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, input.workspaceId),
        eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
        eq(workspaceIntegrations.id, input.integrationId),
      ),
    );
}

function newWorkspaceIntegrationId() {
  return `wint_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function newWorkspaceIntegrationResourceId() {
  return `wres_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
