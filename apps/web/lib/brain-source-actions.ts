"use server";

import type {
  GoatBrainSourceCommand,
  GoatBrainSourceOptions,
  GoatBrainSourceOptionsCommand,
  GoatBrainSourcesDetails as ServiceBrainSourcesDetails,
} from "@opencompany/goat-agent/brain-sources";
import { createOpenCompanyClient } from "@opencompany/protocol";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { GoatWorkspaceActionResult } from "@/lib/workspace-actions";

export type GoatBrainSourceView = ServiceBrainSourcesDetails["sources"][number];
export type GoatOwnSourceAccount = ServiceBrainSourcesDetails["ownAccounts"]["slack"][number];
export type GoatBrainSourcesDetails = ServiceBrainSourcesDetails;

type ConfigureBody<TProvider extends GoatBrainSourceCommand["provider"]> = Extract<
  GoatBrainSourceCommand,
  { operation: "configure"; provider: TProvider }
>;

export async function getGoatBrainSourcesAction(
  brainRef: string,
): Promise<GoatBrainSourcesDetails | null> {
  const response = await (await serverSourceClient()).v1.brains[":brainId"].sources.$get({
    param: { brainId: brainRef },
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw await responseError(response, "Brain sources could not be loaded.");
  return (await response.json()).data;
}

export async function removeGoatBrainSourceAction(input: {
  brainRef: string;
  integrationId: string;
}): Promise<GoatWorkspaceActionResult> {
  return mutateSource(
    async () =>
      (await serverSourceClient()).v1.brains[":brainId"].sources[":integrationId"].$delete({
        param: { brainId: input.brainRef, integrationId: input.integrationId },
      }),
    "Could not remove the brain source.",
  );
}

export async function setGoatBrainSourceEnabledAction(input: {
  brainRef: string;
  provider: GoatBrainSourceCommand["provider"];
  integrationId: string;
  enabled: boolean;
}): Promise<GoatWorkspaceActionResult> {
  return setSource(input.brainRef, input.integrationId, {
    operation: "set_enabled",
    provider: input.provider,
    enabled: input.enabled,
  });
}

export async function setGoatBrainSlackSourceAction(
  input: Omit<ConfigureBody<"slack">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<GoatWorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "slack",
    ...configuration,
  });
}

export async function setGoatBrainLinearSourceAction(
  input: Omit<ConfigureBody<"linear">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<GoatWorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "linear",
    ...configuration,
  });
}

export async function setGoatBrainHubspotSourceAction(
  input: Omit<ConfigureBody<"hubspot">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<GoatWorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "hubspot",
    ...configuration,
  });
}

export async function setGoatBrainAttioSourceAction(
  input: Omit<ConfigureBody<"attio">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<GoatWorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "attio",
    ...configuration,
  });
}

export async function setGoatBrainGitHubSourceAction(
  input: Omit<ConfigureBody<"github">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<GoatWorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "github",
    ...configuration,
  });
}

export async function setGoatBrainGmailSourceAction(
  input: Omit<ConfigureBody<"gmail">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<GoatWorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "gmail",
    ...configuration,
  });
}

export async function setGoatBrainGoogleDriveSourceAction(
  input: Omit<ConfigureBody<"google_drive">, "operation" | "provider"> & {
    brainRef: string;
    integrationId: string;
  },
): Promise<GoatWorkspaceActionResult> {
  const { brainRef, integrationId, ...configuration } = input;
  return setSource(brainRef, integrationId, {
    operation: "configure",
    provider: "google_drive",
    ...configuration,
  });
}

export type GoatSlackConversationListResult =
  | (Omit<Extract<GoatBrainSourceOptions, { provider: "slack" }>, "provider"> & { ok: true })
  | { ok: false; error: string };

export async function listGoatSlackConversationsAction(
  integrationId: string,
): Promise<GoatSlackConversationListResult> {
  const result = await listSourceOptions(integrationId, { provider: "slack" });
  if (!result.ok) return result;
  if (result.data.provider !== "slack") {
    return { ok: false, error: "Slack returned an invalid source-option response." };
  }
  return {
    ok: true,
    channels: result.data.channels,
    dms: result.data.dms,
    partial: result.data.partial,
  };
}

export type GoatLinearTeamListResult =
  | (Omit<Extract<GoatBrainSourceOptions, { provider: "linear" }>, "provider"> & { ok: true })
  | { ok: false; error: string };

export async function listGoatLinearTeamsAction(
  integrationId: string,
): Promise<GoatLinearTeamListResult> {
  const result = await listSourceOptions(integrationId, { provider: "linear" });
  if (!result.ok) return result;
  if (result.data.provider !== "linear") {
    return { ok: false, error: "Linear returned an invalid source-option response." };
  }
  return { ok: true, teams: result.data.teams, partial: result.data.partial };
}

export type GoatGitHubRepositoryListResult =
  | (Omit<Extract<GoatBrainSourceOptions, { provider: "github" }>, "provider"> & { ok: true })
  | { ok: false; error: string };

export async function listGoatGitHubRepositoriesAction(
  integrationId: string,
): Promise<GoatGitHubRepositoryListResult> {
  const result = await listSourceOptions(integrationId, { provider: "github" });
  if (!result.ok) return result;
  if (result.data.provider !== "github") {
    return { ok: false, error: "GitHub returned an invalid source-option response." };
  }
  return { ok: true, repos: result.data.repos };
}

export type GoatGoogleDriveResourceListResult =
  | (Omit<Extract<GoatBrainSourceOptions, { provider: "google_drive" }>, "provider"> & {
      ok: true;
    })
  | { ok: false; error: string };

export async function listGoatGoogleDriveResourcesAction(
  input: Omit<Extract<GoatBrainSourceOptionsCommand, { provider: "google_drive" }>, "provider"> & {
    integrationId: string;
  },
): Promise<GoatGoogleDriveResourceListResult> {
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
  body: GoatBrainSourceCommand,
): Promise<GoatWorkspaceActionResult> {
  return mutateSource(
    async () =>
      (await serverSourceClient()).v1.brains[":brainId"].sources[":integrationId"].$put({
        param: { brainId, integrationId },
        json: body,
      }),
    `Could not update the ${sourceLabel(body.provider)} source.`,
  );
}

async function mutateSource(
  request: () => Promise<Response>,
  fallback: string,
): Promise<GoatWorkspaceActionResult> {
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
  body: GoatBrainSourceOptionsCommand,
): Promise<{ ok: true; data: GoatBrainSourceOptions } | { ok: false; error: string }> {
  try {
    const response = await (await serverSourceClient()).v1.integrations[":integrationId"][
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

async function serverSourceClient() {
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  const authorization = incoming.get("authorization");
  const browserOrigin = incoming.get("origin");
  const fetchWithActor: typeof globalThis.fetch = async (input, init) => {
    const forwarded = new Headers(init?.headers);
    if (cookie) forwarded.set("Cookie", cookie);
    if (authorization) forwarded.set("Authorization", authorization);
    if (browserOrigin) forwarded.set("Origin", browserOrigin);
    return globalThis.fetch(input, { ...init, headers: forwarded, cache: "no-store" });
  };
  return createOpenCompanyClient(apiOrigin(process.env.GOAT_API_ORIGIN), {
    fetch: fetchWithActor,
  });
}

function apiOrigin(value: string | undefined) {
  if (!value?.trim()) throw new Error("The canonical API origin is unavailable.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The canonical API origin is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("The canonical API origin is invalid.");
  }
  return url.origin;
}

async function responseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : fallback;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(`${message}${requestId ? ` (request ${requestId})` : ""}`);
}

function sourceLabel(provider: GoatBrainSourceCommand["provider"]) {
  switch (provider) {
    case "google_drive":
      return "Google Drive";
    case "github":
      return "GitHub";
    case "hubspot":
      return "HubSpot";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}
