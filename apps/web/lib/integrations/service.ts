import { getDb } from "@opencompany/db/client";
import {
  workspaceGitHubIntegrationInstallations,
  workspaceGitHubIntegrationRepositories,
} from "@opencompany/db/schema";
import { and, eq, notInArray } from "drizzle-orm";
import type { GitHubWorkRepository } from "@/lib/integrations/github";

export async function syncGitHubIntegrationRepositories(input: {
  workspaceId: string;
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
  repositories: GitHubWorkRepository[];
}) {
  const db = getDb();
  const now = new Date();

  await db
    .insert(workspaceGitHubIntegrationInstallations)
    .values({
      id: `wghi_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceGitHubIntegrationInstallations.workspaceId,
      set: {
        installationId: input.installationId,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        updatedAt: now,
      },
    });

  for (const repository of input.repositories) {
    await db
      .insert(workspaceGitHubIntegrationRepositories)
      .values({
        id: `wghr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        workspaceId: input.workspaceId,
        installationId: input.installationId,
        githubRepoId: repository.githubRepoId,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
        private: repository.private,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceGitHubIntegrationRepositories.workspaceId,
          workspaceGitHubIntegrationRepositories.fullName,
        ],
        set: {
          installationId: input.installationId,
          githubRepoId: repository.githubRepoId,
          defaultBranch: repository.defaultBranch,
          private: repository.private,
          updatedAt: now,
        },
      });
  }

  if (input.repositories.length > 0) {
    await db.delete(workspaceGitHubIntegrationRepositories).where(
      and(
        eq(workspaceGitHubIntegrationRepositories.workspaceId, input.workspaceId),
        notInArray(
          workspaceGitHubIntegrationRepositories.fullName,
          input.repositories.map((repository) => repository.fullName),
        ),
      ),
    );
  } else {
    await db
      .delete(workspaceGitHubIntegrationRepositories)
      .where(eq(workspaceGitHubIntegrationRepositories.workspaceId, input.workspaceId));
  }
}
