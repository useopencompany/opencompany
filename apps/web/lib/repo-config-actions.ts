"use server";

import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiError, serverApiErrorMessage } from "@/lib/server-api-client";

// Mirror the protocol's WorkspaceRepository/RepoConfig contracts with concrete
// web-side types: the generated z.infer types collapse to `any` under this
// app's tsconfig. Env values never appear here — only saved key names.
export type GoatWorkspaceRepository = {
  repositoryExternalId: string;
  repositoryFullName: string;
  private: boolean;
};

type RepoConfigDto = {
  repositoryExternalId: string;
  repositoryFullName: string;
  envKeys: string[];
  setupInstructions: string;
  updatedAt: string;
};

export type GoatRepoConfigView = Omit<RepoConfigDto, "updatedAt"> & { updatedAt: Date };

export type GoatRepoConfigMutationResult =
  | { ok: true; config: GoatRepoConfigView }
  | { ok: false; message: string };

export type GoatRepoConfigDeleteResult =
  | { ok: true; repositoryExternalId: string }
  | { ok: false; message: string };

// Mirrors the API's path-parameter contract so obviously invalid ids keep the
// retired Server Action's messages instead of a generic validation error.
const REPOSITORY_EXTERNAL_ID_PATTERN = /^[1-9]\d{0,63}$/;

function isValidRepositoryMutationInput(input: unknown): input is {
  repositoryExternalId: string;
} {
  return (
    typeof input === "object" &&
    input !== null &&
    "repositoryExternalId" in input &&
    typeof input.repositoryExternalId === "string" &&
    REPOSITORY_EXTERNAL_ID_PATTERN.test(input.repositoryExternalId)
  );
}

export async function listGoatRepoConfigsAction(): Promise<{
  repositories: GoatWorkspaceRepository[];
  configs: GoatRepoConfigView[];
}> {
  const response = await (await serverApiClient()).v1["repo-configs"].$get();
  if (!response.ok) {
    throw await serverApiError(response, "Repository configurations could not be loaded.");
  }
  const data = (await response.json()).data as {
    repositories: GoatWorkspaceRepository[];
    configs: RepoConfigDto[];
  };
  return {
    repositories: data.repositories,
    configs: data.configs.map(configView),
  };
}

export async function saveGoatRepoEnvAction(input: {
  repositoryExternalId: string;
  envContent: string;
}): Promise<GoatRepoConfigMutationResult> {
  if (!isValidRepositoryMutationInput(input) || typeof input.envContent !== "string") {
    return { ok: false, message: "Invalid repository environment." };
  }
  return mutateConfig(
    async () =>
      (await serverApiClient()).v1["repo-configs"][":repositoryExternalId"].env.$put({
        param: { repositoryExternalId: input.repositoryExternalId },
        json: { content: input.envContent },
      }),
    "Repository environment could not be saved.",
  );
}

export async function clearGoatRepoEnvAction(input: {
  repositoryExternalId: string;
}): Promise<GoatRepoConfigMutationResult> {
  if (!isValidRepositoryMutationInput(input)) {
    return { ok: false, message: "Invalid repository." };
  }
  return mutateConfig(
    async () =>
      (await serverApiClient()).v1["repo-configs"][":repositoryExternalId"].env.$put({
        param: { repositoryExternalId: input.repositoryExternalId },
        json: { content: null },
      }),
    "Repository environment could not be cleared.",
  );
}

export async function saveGoatRepoSetupInstructionsAction(input: {
  repositoryExternalId: string;
  setupInstructions: string;
}): Promise<GoatRepoConfigMutationResult> {
  if (!isValidRepositoryMutationInput(input) || typeof input.setupInstructions !== "string") {
    return { ok: false, message: "Invalid setup instructions." };
  }
  return mutateConfig(
    async () =>
      (await serverApiClient()).v1["repo-configs"][":repositoryExternalId"].setup.$put({
        param: { repositoryExternalId: input.repositoryExternalId },
        json: { setupInstructions: input.setupInstructions },
      }),
    "Setup instructions could not be saved.",
  );
}

export async function deleteGoatRepoConfigAction(input: {
  repositoryExternalId: string;
}): Promise<GoatRepoConfigDeleteResult> {
  if (!isValidRepositoryMutationInput(input)) {
    return { ok: false, message: "Invalid repository." };
  }
  try {
    const response = await (await serverApiClient()).v1["repo-configs"][
      ":repositoryExternalId"
    ].$delete({ param: { repositoryExternalId: input.repositoryExternalId } });
    if (!response.ok) {
      return {
        ok: false,
        message: await serverApiErrorMessage(
          response,
          "Repository configuration could not be removed.",
        ),
      };
    }
    const data = (await response.json()).data;
    revalidatePath("/settings/repositories");
    return { ok: true, repositoryExternalId: data.repositoryExternalId };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Repository configuration could not be removed.",
    };
  }
}

async function mutateConfig(
  request: () => Promise<Response>,
  fallback: string,
): Promise<GoatRepoConfigMutationResult> {
  try {
    const response = await request();
    if (!response.ok) {
      return { ok: false, message: await serverApiErrorMessage(response, fallback) };
    }
    const data = (await response.json()) as { data: RepoConfigDto };
    revalidatePath("/settings/repositories");
    return { ok: true, config: configView(data.data) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : fallback };
  }
}

function configView(config: RepoConfigDto): GoatRepoConfigView {
  return { ...config, updatedAt: new Date(config.updatedAt) };
}
