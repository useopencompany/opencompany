"use server";

import type { SentrySettingsDto } from "@opencompany/protocol";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "./server-api-client";

async function result<T>(response: Response, mutation = false): Promise<T> {
  if (!response.ok)
    throw new Error(await serverApiErrorMessage(response, "Sentry request failed."));
  if (mutation) revalidatePath("/plugins", "layout");
  return ((await response.json()) as { data: T }).data;
}
export async function getCompanySentryPluginAction() {
  const client = await serverApiClient();
  const response = await client.v1["company-plugins"].sentry.$get();
  return result<import("@opencompany/protocol").CompanySentryPluginDto>(response);
}
export async function listSentryProjectsAction(all = false, cursor?: string) {
  const client = await serverApiClient();
  const response = await client.v1["company-plugins"].sentry.projects.$get({
    query: { all: all ? "true" : "false", ...(cursor ? { cursor } : {}) },
  });
  return result<{
    projects: import("@opencompany/protocol").SentryProjectDto[];
    nextCursor: string | null;
  }>(response);
}
export async function connectSentryAction(input: {
  installationId: string;
  code: string;
  region: "us" | "eu";
}) {
  const client = await serverApiClient();
  return result<import("@opencompany/protocol").CompanySentryPluginDto>(
    await client.v1["company-plugins"].sentry.connect.$post({ json: input }),
    true,
  );
}
export async function saveSentrySettingsAction(input: SentrySettingsDto) {
  const client = await serverApiClient();
  return result<import("@opencompany/protocol").CompanySentryPluginDto>(
    await client.v1["company-plugins"].sentry.settings.$put({ json: input }),
    true,
  );
}
export async function disconnectSentryAction() {
  const client = await serverApiClient();
  return result<import("@opencompany/protocol").CompanySentryPluginDto>(
    await client.v1["company-plugins"].sentry.$delete(),
    true,
  );
}
export async function validateSentryFixAction(input: {
  repository: string;
  baseBranch: string;
  engine: "codex" | "claude-code";
}) {
  const client = await serverApiClient();
  return result<typeof input>(
    await client.v1["company-plugins"].sentry["validate-fix"].$post({ json: input }),
  );
}
