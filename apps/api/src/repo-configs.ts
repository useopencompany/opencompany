import type { Actor } from "@opencompany/core";
import {
  deleteRepoConfig,
  isValidGitHubRepositoryExternalId,
  listRepoConfigs,
  listWorkspaceRepositories,
  normalizeRepoSetupInstructions,
  type RepoConfigView,
  upsertRepoConfig,
  validateRepoEnv,
  type WorkspaceRepository,
} from "@opencompany/db/repo-configs";
import { createLogger } from "@opencompany/observability";
import { ApiError } from "./errors";

const logger = createLogger({ service: "opencompany-api", runtime: "repo-configs" });

type DbLike = any;

export type RepoConfigService = {
  list(actor: Actor): Promise<{
    repositories: WorkspaceRepository[];
    configs: RepoConfigView[];
  }>;
  // content replaces the stored env file; null clears it. Responses only ever
  // carry env key names — stored values are write-only.
  setEnv(
    actor: Actor,
    repositoryExternalId: string,
    content: string | null,
  ): Promise<RepoConfigView>;
  setSetupInstructions(
    actor: Actor,
    repositoryExternalId: string,
    setupInstructions: string,
  ): Promise<RepoConfigView>;
  remove(actor: Actor, repositoryExternalId: string): Promise<void>;
};

export function createRepoConfigService(input: { db: DbLike }): RepoConfigService {
  return {
    async list(actor) {
      const [repositories, configs] = await Promise.all([
        listWorkspaceRepositories({ db: input.db, workspaceId: actor.workspaceId }),
        listRepoConfigs({ db: input.db, workspaceId: actor.workspaceId }),
      ]);
      return { repositories, configs };
    },

    async setEnv(actor, repositoryExternalId, content) {
      requireAdmin(actor);
      requireValidRepositoryId(repositoryExternalId);
      if (content !== null) {
        const validation = validateRepoEnv(content);
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.message);
      }
      const repository = await resolveConfigurableRepository(input.db, {
        workspaceId: actor.workspaceId,
        repositoryExternalId,
      });
      if (!repository) {
        throw new ApiError(
          404,
          "not_found",
          content === null
            ? "Repository configuration not found."
            : "This repository is not available to the workspace.",
        );
      }
      try {
        return await upsertRepoConfig({
          db: input.db,
          workspaceId: actor.workspaceId,
          ...repository,
          createdByWorkosId: actor.userId,
          env: content === null ? null : { content },
        });
      } catch (error) {
        throw mutationFailure(
          content === null ? "clear environment" : "save environment",
          actor,
          repositoryExternalId,
          error,
          content === null
            ? "Repository environment could not be cleared."
            : "Repository environment could not be saved.",
        );
      }
    },

    async setSetupInstructions(actor, repositoryExternalId, setupInstructions) {
      requireAdmin(actor);
      requireValidRepositoryId(repositoryExternalId);
      const normalized = normalizeRepoSetupInstructions(setupInstructions);
      if (!normalized.ok) throw new ApiError(400, "invalid_request", normalized.message);
      const repository = await resolveConfigurableRepository(input.db, {
        workspaceId: actor.workspaceId,
        repositoryExternalId,
      });
      if (!repository) {
        throw new ApiError(404, "not_found", "This repository is not available to the workspace.");
      }
      try {
        return await upsertRepoConfig({
          db: input.db,
          workspaceId: actor.workspaceId,
          ...repository,
          createdByWorkosId: actor.userId,
          setupInstructions: normalized.instructions,
        });
      } catch (error) {
        throw mutationFailure(
          "save setup instructions",
          actor,
          repositoryExternalId,
          error,
          "Setup instructions could not be saved.",
        );
      }
    },

    async remove(actor, repositoryExternalId) {
      requireAdmin(actor);
      requireValidRepositoryId(repositoryExternalId);
      let deleted: boolean;
      try {
        deleted = await deleteRepoConfig({
          db: input.db,
          workspaceId: actor.workspaceId,
          repositoryExternalId,
        });
      } catch (error) {
        throw mutationFailure(
          "remove",
          actor,
          repositoryExternalId,
          error,
          "Repository configuration could not be removed.",
        );
      }
      if (!deleted) {
        throw new ApiError(404, "not_found", "Repository configuration not found.");
      }
    },
  };
}

function requireAdmin(actor: Actor) {
  if (actor.role !== "admin") {
    throw new ApiError(
      403,
      "forbidden",
      "Only workspace admins can configure repository environments.",
    );
  }
}

function requireValidRepositoryId(repositoryExternalId: string) {
  if (!isValidGitHubRepositoryExternalId(repositoryExternalId)) {
    throw new ApiError(400, "invalid_request", "Invalid repository.");
  }
}

// Membership validation: only repositories in the workspace's connected GitHub
// catalog are configurable, and the stored full name always mirrors the catalog.
async function resolveConfigurableRepository(
  db: DbLike,
  input: { workspaceId: string; repositoryExternalId: string },
): Promise<{ repositoryExternalId: string; repositoryFullName: string } | null> {
  const repositories = await listWorkspaceRepositories({
    db,
    workspaceId: input.workspaceId,
  });
  const repository = repositories.find(
    (candidate) => candidate.repositoryExternalId === input.repositoryExternalId,
  );
  return repository
    ? {
        repositoryExternalId: repository.repositoryExternalId,
        repositoryFullName: repository.repositoryFullName,
      }
    : null;
}

function mutationFailure(
  operation: string,
  actor: Actor,
  repositoryExternalId: string,
  error: unknown,
  message: string,
) {
  logger.error(`Failed to ${operation} for repository configuration`, {
    event: "opencompany.repo_config_mutation_failed",
    workspace_id: actor.workspaceId,
    repository_external_id: repositoryExternalId,
    error_name: error instanceof Error ? error.name : "UnknownError",
  });
  return new ApiError(500, "internal_error", message, true);
}
