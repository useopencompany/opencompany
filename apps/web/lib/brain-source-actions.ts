"use server";

import type {
  BrainSourceCommand,
  BrainSourceOptions,
  BrainSourceOptionsCommand,
  BrainSourcesDetails as ServiceBrainSourcesDetails,
} from "@opencompany/agent/brain-sources";
import { revalidatePath } from "next/cache";
import { serverApiClient } from "@/lib/server-api-client";
import type { WorkspaceActionResult } from "@/lib/workspace-actions";

export type BrainSourceView = ServiceBrainSourcesDetails["sources"][number];
export type OwnSourceAccount = ServiceBrainSourcesDetails["ownAccounts"]["linear"][number];
export type BrainSourcesDetails = ServiceBrainSourcesDetails;

type ConfigureBody<TProvider extends BrainSourceCommand["provider"]> = Extract<
  BrainSourceCommand,
  { operation: "configure"; provider: TProvider }
>;

export async function getBrainSourcesAction(brainRef: string): Promise<BrainSourcesDetails | null> {
  const response = await (await serverApiClient()).v1.brains[":brainId"].sources.$get({
    param: { brainId: brainRef },
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw await responseError(response, "Brain sources could not be loaded.");
  return (await response.json()).data;
}

export async function removeBrainSourceAction(input: {
  brainRef: string;
  integrationId: string;
}): Promise<WorkspaceActionResult> {
  return mutateSource(
    async () =>
      (await serverApiClient()).v1.brains[":brainId"].sources[":integrationId"].$delete({
        param: { brainId: input.brainRef, integrationId: input.integrationId },
      }),
    "Could not remove the brain source.",
  );
}

export async function setBrainSourceEnabledAction(input: {
  brainRef: string;
  provider: BrainSourceCommand["provider"];
  integrationId: string;
  enabled: boolean;
}): Promise<WorkspaceActionResult> {
  return setSource(input.brainRef, input.integrationId, {
    operation: "set_enabled",
    provider: input.provider,
    enabled: input.enabled,
  });
}

export async function setBrainLinearSourceAction(
  input: Omit<ConfigureBody<"linear">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<WorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "linear",
    ...configuration,
  });
}

export async function setBrainHubspotSourceAction(
  input: Omit<ConfigureBody<"hubspot">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<WorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "hubspot",
    ...configuration,
  });
}

export async function setBrainAttioSourceAction(
  input: Omit<ConfigureBody<"attio">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<WorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "attio",
    ...configuration,
  });
}

export async function setBrainGmailSourceAction(
  input: Omit<ConfigureBody<"gmail">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<WorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "gmail",
    ...configuration,
  });
}

export async function setBrainGoogleDriveSourceAction(
  input: Omit<ConfigureBody<"google_drive">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<WorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "google_drive",
    ...configuration,
  });
}

export type LinearTeamListResult =
  | (Omit<Extract<BrainSourceOptions, { provider: "linear" }>, "provider"> & { ok: true })
  | { ok: false; error: string };

export async function listLinearTeamsAction(integrationId: string): Promise<LinearTeamListResult> {
  const result = await listSourceOptions(integrationId, { provider: "linear" });
  if (!result.ok) return result;
  if (result.data.provider !== "linear") {
    return { ok: false, error: "Linear returned an invalid source-option response." };
  }
  return { ok: true, teams: result.data.teams, partial: result.data.partial };
}

export type GoogleDriveResourceListResult =
  | (Omit<Extract<BrainSourceOptions, { provider: "google_drive" }>, "provider"> & {
      ok: true;
    })
  | { ok: false; error: string };

export async function listGoogleDriveResourcesAction(
  input: Omit<Extract<BrainSourceOptionsCommand, { provider: "google_drive" }>, "provider"> & {
    integrationId: string;
  },
): Promise<GoogleDriveResourceListResult> {
  const { integrationId, ...options } = input;
  const result = await listSourceOptions(integrationId, {
    provider: "google_drive",
    ...options,
  });
  if (!result.ok) return result;
  if (result.data.provider !== "google_drive") {
    return { ok: false, error: "Google Drive returned an invalid source-option response." };
  }
  return {
    ok: true,
    files: result.data.files,
    nextPageToken: result.data.nextPageToken,
  };
}

async function setSource(
  brainId: string,
  integrationId: string,
  body: BrainSourceCommand,
): Promise<WorkspaceActionResult> {
  return mutateSource(
    async () =>
      (await serverApiClient()).v1.brains[":brainId"].sources[":integrationId"].$put({
        param: { brainId, integrationId },
        json: body,
      }),
    `Could not update the ${sourceLabel(body.provider)} source.`,
  );
}

async function mutateSource(
  request: () => Promise<Response>,
  fallback: string,
): Promise<WorkspaceActionResult> {
  try {
    const response = await request();
    if (!response.ok)
      return { ok: false, error: (await responseError(response, fallback)).message };
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : fallback };
  }
}

async function listSourceOptions(
  integrationId: string,
  body: BrainSourceOptionsCommand,
): Promise<{ ok: true; data: BrainSourceOptions } | { ok: false; error: string }> {
  try {
    const response = await (await serverApiClient()).v1.integrations[":integrationId"][
      "brain-source-options"
    ].$post({ param: { integrationId }, json: body });
    if (!response.ok) {
      return {
        ok: false,
        error: (await responseError(response, "Source options could not be loaded.")).message,
      };
    }
    return { ok: true, data: (await response.json()).data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Source options could not be loaded.",
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

function sourceLabel(provider: BrainSourceCommand["provider"]) {
  switch (provider) {
    case "google_drive":
      return "Google Drive";
    case "hubspot":
      return "HubSpot";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}
