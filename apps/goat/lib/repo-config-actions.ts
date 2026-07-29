"use server";

import { getDb } from "@opencompany/db/client";
import {
  deleteGoatRepoConfig,
  type GoatRepoConfigView,
  isValidGitHubRepositoryExternalId,
  listGoatWorkspaceRepositories,
  upsertGoatRepoConfig,
} from "@opencompany/db/goat-repo-configs";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { normalizeGoatRepoSetupInstructions, validateGoatRepoEnv } from "@/lib/repo-env";

export type GoatRepoConfigMutationResult =
  | { ok: true; config: GoatRepoConfigView }
  | { ok: false; message: string };

export type GoatRepoConfigDeleteResult =
  | { ok: true; repositoryExternalId: string }
  | { ok: false; message: string };

async function requireWorkspaceAdmin(): Promise<
  { ok: false; message: string } | { ok: true; workspaceId: string; userWorkosId: string }
> {
  const context = await currentGoatUser({ optional: true });
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
  const repositories = await listGoatWorkspaceRepositories({
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

export async function saveGoatRepoEnvAction(input: {
  repositoryExternalId: string;
  envContent: string;
}): Promise<GoatRepoConfigMutationResult> {
  if (!isValidRepositoryMutationInput(input) || typeof input.envContent !== "string") {
    return { ok: false, message: "Invalid repository environment." };
  }

  const validation = validateGoatRepoEnv(input.envContent);
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
    const config = await upsertGoatRepoConfig({
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

export async function clearGoatRepoEnvAction(input: {
  repositoryExternalId: string;
}): Promise<GoatRepoConfigMutationResult> {
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
    const config = await upsertGoatRepoConfig({
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

export async function saveGoatRepoSetupInstructionsAction(input: {
  repositoryExternalId: string;
  setupInstructions: string;
}): Promise<GoatRepoConfigMutationResult> {
  if (!isValidRepositoryMutationInput(input) || typeof input.setupInstructions !== "string") {
    return { ok: false, message: "Invalid setup instructions." };
  }
  const normalized = normalizeGoatRepoSetupInstructions(input.setupInstructions);
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
    const config = await upsertGoatRepoConfig({
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

export async function deleteGoatRepoConfigAction(input: {
  repositoryExternalId: string;
}): Promise<GoatRepoConfigDeleteResult> {
  if (!isValidRepositoryMutationInput(input)) {
    return { ok: false, message: "Invalid repository." };
  }
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;

  try {
    const deleted = await deleteGoatRepoConfig({
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
