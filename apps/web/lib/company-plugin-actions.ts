"use server";

import type {
  CompanyGitHubAvailableInstallationsDto,
  CompanyGitHubPluginDto,
} from "@opencompany/protocol";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type CompanyPluginActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function getCompanyGitHubPluginAction(): Promise<CompanyGitHubPluginDto> {
  const response = await (await serverApiClient()).v1["company-plugins"].github.$get();
  if (!response.ok) {
    throw new Error(await serverApiErrorMessage(response, "Could not load the GitHub plugin."));
  }
  return (await response.json()).data;
}

// Trigger editors offer company GitHub as one more provider; if it can't be read, they keep working
// with the member's personal providers instead of failing the whole page.
export async function getCompanyGitHubPluginForTriggersAction(): Promise<CompanyGitHubPluginDto | null> {
  try {
    return await getCompanyGitHubPluginAction();
  } catch {
    return null;
  }
}

export async function listCompanyGitHubAvailableInstallationsAction(): Promise<
  CompanyPluginActionResult<CompanyGitHubAvailableInstallationsDto>
> {
  return request("Could not load your GitHub accounts.", { revalidate: false }, async (client) =>
    client.v1["company-plugins"].github["available-installations"].$get(),
  );
}

export async function linkCompanyGitHubInstallationAction(
  installationId: string,
): Promise<CompanyPluginActionResult<CompanyGitHubPluginDto>> {
  return request("Could not connect this GitHub account.", { revalidate: true }, async (client) =>
    client.v1["company-plugins"].github.installations.$post({ json: { installationId } }),
  );
}

export async function unlinkCompanyGitHubInstallationAction(
  integrationId: string,
): Promise<CompanyPluginActionResult<CompanyGitHubPluginDto>> {
  return request(
    "Could not disconnect this GitHub account.",
    { revalidate: true },
    async (client) =>
      client.v1["company-plugins"].github.installations[":integrationId"].$delete({
        param: { integrationId },
      }),
  );
}

async function request<T>(
  fallback: string,
  options: { revalidate: boolean },
  send: (
    client: Awaited<ReturnType<typeof serverApiClient>>,
  ) => Promise<Response & { json(): Promise<unknown> }>,
): Promise<CompanyPluginActionResult<T>> {
  try {
    const response = await send(await serverApiClient());
    if (!response.ok) return { ok: false, error: await serverApiErrorMessage(response, fallback) };
    if (options.revalidate) revalidatePath("/plugins", "layout");
    return { ok: true, data: ((await response.json()) as { data: T }).data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : fallback };
  }
}
