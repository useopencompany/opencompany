"use server";

import { getDb } from "@opencompany/db/client";
import {
  deleteRepoConfig,
  isValidGitHubRepositoryExternalId,
  listWorkspaceRepositories,
  type RepoConfigView,
  upsertRepoConfig,
} from "@opencompany/db/repo-configs";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { normalizeRepoSetupInstructions, validateRepoEnv } from "@/lib/repo-env";

export type RepoConfigMutationResult =
  | { ok: true; config: RepoConfigView }
  | { ok: false; message: string };

export type RepoConfigDeleteResult =
  | { ok: true; repositoryExternalId: string }
  | { ok: false; message: string };

async function requireWorkspaceAdmin(): Promise<
  { ok: false; message: string } | { ok: true; workspaceId: string; userWorkosId: string }
> {
  const context = await currentUser({ optional: true });
  if (!context) return { ok: false, message: "You must be signed in." };
  if (context.role !== "admin") {
    return {
      ok: false,
      message: "Only workspace admins can configure repository environments.",
    };
  }
  return { ok: true, workspaceId: context.workspace.id, userWorkosId: context.user.workosUserId };
}

async function resolveConfigurableRepository(input: {
  workspaceId: string;
  repositoryExternalId: string;
}): Promise<{ repositoryExternalId: string; repositoryFullName: string } | null> {
  const db = getDb();
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

function isValidRepositoryMutationInput(input: unknown): input is {
  repositoryExternalId: string;
} {
  return (
    typeof input === "object" &&
    input !== null &&
    "repositoryExternalId" in input &&
    typeof input.repositoryExternalId === "string" &&
    isValidGitHubRepositoryExternalId(input.repositoryExternalId)
  );
}

export async function saveRepoEnvAction(input: {
  repositoryExternalId: string;
  envContent: string;
}): Promise<RepoConfigMutationResult> {
  if (!isValidRepositoryMutationInput(input) || typeof input.envContent !== "string") {
    return { ok: false, message: "Invalid repository environment." };
  }

  const validation = validateRepoEnv(input.envContent);
  if (!validation.ok) return validation;
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;

  try {
    const repository = await resolveConfigurableRepository({
      workspaceId: gate.workspaceId,
      repositoryExternalId: input.repositoryExternalId,
    });
    if (!repository) {
      return { ok: false, message: "This repository is not available to the workspace." };
    }
    const config = await upsertRepoConfig({
      db: getDb(),
      workspaceId: gate.workspaceId,
      ...repository,
      createdByWorkosId: gate.userWorkosId,
      env: { content: input.envContent },
    });
    revalidatePath("/settings/repositories");
    return { ok: true, config };
  } catch (error) {
    reportMutationFailure("save environment", gate, input.repositoryExternalId, error);
    return { ok: false, message: "Repository environment could not be saved." };
  }
}

export async function clearRepoEnvAction(input: {
  repositoryExternalId: string;
}): Promise<RepoConfigMutationResult> {
  if (!isValidRepositoryMutationInput(input)) {
    return { ok: false, message: "Invalid repository." };
  }
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;

  try {
    const repository = await resolveConfigurableRepository({
      workspaceId: gate.workspaceId,
      repositoryExternalId: input.repositoryExternalId,
    });
    if (!repository) {
      return { ok: false, message: "Repository configuration not found." };
    }
    const config = await upsertRepoConfig({
      db: getDb(),
      workspaceId: gate.workspaceId,
      ...repository,
      createdByWorkosId: gate.userWorkosId,
      env: null,
    });
    revalidatePath("/settings/repositories");
    return { ok: true, config };
  } catch (error) {
    reportMutationFailure("clear environment", gate, input.repositoryExternalId, error);
    return { ok: false, message: "Repository environment could not be cleared." };
  }
}

export async function saveRepoSetupInstructionsAction(input: {
  repositoryExternalId: string;
  setupInstructions: string;
}): Promise<RepoConfigMutationResult> {
  if (!isValidRepositoryMutationInput(input) || typeof input.setupInstructions !== "string") {
    return { ok: false, message: "Invalid setup instructions." };
  }
  const normalized = normalizeRepoSetupInstructions(input.setupInstructions);
  if (!normalized.ok) return normalized;
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;

  try {
    const repository = await resolveConfigurableRepository({
      workspaceId: gate.workspaceId,
      repositoryExternalId: input.repositoryExternalId,
    });
    if (!repository) {
      return { ok: false, message: "This repository is not available to the workspace." };
    }
    const config = await upsertRepoConfig({
      db: getDb(),
      workspaceId: gate.workspaceId,
      ...repository,
      createdByWorkosId: gate.userWorkosId,
      setupInstructions: normalized.instructions,
    });
    revalidatePath("/settings/repositories");
    return { ok: true, config };
  } catch (error) {
    reportMutationFailure("save setup instructions", gate, input.repositoryExternalId, error);
    return { ok: false, message: "Setup instructions could not be saved." };
  }
}

export async function deleteRepoConfigAction(input: {
  repositoryExternalId: string;
}): Promise<RepoConfigDeleteResult> {
  if (!isValidRepositoryMutationInput(input)) {
    return { ok: false, message: "Invalid repository." };
  }
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;

  try {
    const deleted = await deleteRepoConfig({
      db: getDb(),
      workspaceId: gate.workspaceId,
      repositoryExternalId: input.repositoryExternalId,
    });
    if (!deleted) {
      return { ok: false, message: "Repository configuration not found." };
    }
    revalidatePath("/settings/repositories");
    return { ok: true, repositoryExternalId: input.repositoryExternalId };
  } catch (error) {
    reportMutationFailure("remove", gate, input.repositoryExternalId, error);
    return { ok: false, message: "Repository configuration could not be removed." };
  }
}

function reportMutationFailure(
  operation: string,
  context: { workspaceId: string },
  repositoryExternalId: string,
  error: unknown,
) {
  console.error(`[goat] Failed to ${operation} for repository configuration`, {
    workspaceId: context.workspaceId,
    repositoryExternalId,
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
}
