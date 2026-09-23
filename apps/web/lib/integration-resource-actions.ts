"use server";

import type {
  IntegrationResourceOptions,
  IntegrationResourceOptionsCommand,
} from "@opencompany/agent/integration-resource-options";
import { serverApiClient } from "@/lib/server-api-client";

export type LinearTeamListResult =
  | (Omit<Extract<IntegrationResourceOptions, { provider: "linear" }>, "provider"> & { ok: true })
  | { ok: false; error: string };

export async function listLinearTeamsAction(
  integrationId: string,
  options: { includeTriageStateIds?: boolean } = {},
): Promise<LinearTeamListResult> {
  const result = await listResourceOptions(integrationId, {
    provider: "linear",
    ...(options.includeTriageStateIds ? { includeTriageStateIds: true } : {}),
  });
  if (!result.ok) return result;
  if (result.data.provider !== "linear") {
    return { ok: false, error: "Linear returned an invalid resource-option response." };
  }
  return { ok: true, teams: result.data.teams, partial: result.data.partial };
}

export type GranolaFolderListResult =
  | (Omit<Extract<IntegrationResourceOptions, { provider: "granola" }>, "provider"> & { ok: true })
  | { ok: false; error: string };

export async function listGranolaFoldersAction(
  integrationId: string,
): Promise<GranolaFolderListResult> {
  const result = await listResourceOptions(integrationId, { provider: "granola" });
  if (!result.ok) return result;
  if (result.data.provider !== "granola") {
    return { ok: false, error: "Granola returned an invalid resource-option response." };
  }
  return { ok: true, folders: result.data.folders, partial: result.data.partial };
}

export type GmailLabelListResult =
  | (Omit<Extract<IntegrationResourceOptions, { provider: "gmail" }>, "provider"> & { ok: true })
  | { ok: false; error: string };

export async function listGmailLabelsAction(integrationId: string): Promise<GmailLabelListResult> {
  const result = await listResourceOptions(integrationId, { provider: "gmail" });
  if (!result.ok) return result;
  if (result.data.provider !== "gmail") {
    return { ok: false, error: "Gmail returned an invalid resource-option response." };
  }
  return { ok: true, labels: result.data.labels };
}

export type GitHubRepositoryListResult =
  | (Omit<Extract<IntegrationResourceOptions, { provider: "github_app" }>, "provider"> & {
      ok: true;
    })
  | { ok: false; error: string };

export async function listCompanyGitHubRepositoriesAction(
  integrationId: string,
): Promise<GitHubRepositoryListResult> {
  const result = await listResourceOptions(integrationId, { provider: "github_app" });
  if (!result.ok) return result;
  if (result.data.provider !== "github_app") {
    return { ok: false, error: "GitHub returned an invalid resource-option response." };
  }
  return { ok: true, repositories: result.data.repositories };
}

async function listResourceOptions(
  integrationId: string,
  body: IntegrationResourceOptionsCommand,
): Promise<{ ok: true; data: IntegrationResourceOptions } | { ok: false; error: string }> {
  try {
    const response = await (await serverApiClient()).v1.integrations[":integrationId"][
      "resource-options"
    ].$post({ param: { integrationId }, json: body });
    if (!response.ok) {
      return {
        ok: false,
        error: (await responseError(response, "Resource options could not be loaded.")).message,
      };
    }
    return { ok: true, data: (await response.json()).data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Resource options could not be loaded.",
    };
  }
}

async function responseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : fallback;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(`${message}${requestId ? ` (request ${requestId})` : ""}`);
}
