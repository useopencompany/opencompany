"use server";

import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiError, serverApiErrorMessage } from "@/lib/server-api-client";

// Mirrors GOAT_INFISICAL_HOSTS in @opencompany/db/goat-infisical-auth without
// pulling the db package into this API-only adapter; the API validates
// membership server-side.
export type GoatInfisicalHost = "https://app.infisical.com" | "https://eu.infisical.com";

export type GoatInfisicalAuthSettings = {
  status: "connected" | "needs_reauth" | "disconnected" | null;
  statusReason: string | null;
  accountEmail: string | null;
  host: GoatInfisicalHost | null;
  lastValidatedAt: string | null;
};

export type GoatInfisicalAuthFlow = {
  id: string;
  status: "pending" | "link_ready" | "completed" | "failed" | "expired";
  loginUrl: string | null;
  statusReason: string | null;
  expiresAt: string;
};

export async function loadCurrentGoatInfisicalAuthSettings(): Promise<GoatInfisicalAuthSettings> {
  const response = await (await serverApiClient()).v1["engine-auth"].infisical.$get();
  if (!response.ok) {
    throw await serverApiError(response, "Could not load the Infisical connection.");
  }
  return (await response.json()).data as GoatInfisicalAuthSettings;
}

export async function startGoatInfisicalAuth(input: { host: GoatInfisicalHost }) {
  try {
    const response = await (await serverApiClient()).v1["engine-auth"].infisical.start.$post({
      json: { host: input.host },
    });
    if (!response.ok) {
      return {
        ok: false as const,
        error: await serverApiErrorMessage(response, "Could not start Infisical authentication."),
      };
    }
    const data = (await response.json()).data as { flow: GoatInfisicalAuthFlow };
    return { ok: true as const, flow: data.flow };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not start Infisical authentication.",
    };
  }
}

export async function completeGoatInfisicalAuth(input: { flowId: string; browserToken: string }) {
  const flowId = input.flowId.trim();
  const browserToken = input.browserToken.trim();
  if (!flowId || !browserToken) {
    return { ok: false as const, error: "Paste the browser token from Infisical." };
  }
  if (browserToken.length > 64 * 1024) {
    return { ok: false as const, error: "That Infisical browser token is too large." };
  }
  try {
    const response = await (await serverApiClient()).v1["engine-auth"].infisical[
      ":flowId"
    ].complete.$post({ param: { flowId }, json: { browserToken } });
    if (!response.ok) {
      return {
        ok: false as const,
        error: await serverApiErrorMessage(
          response,
          "Could not complete Infisical authentication.",
        ),
      };
    }
    const data = (await response.json()).data as { flow: GoatInfisicalAuthFlow };
    if (data.flow.status === "completed") revalidatePath("/settings");
    return { ok: true as const, flow: data.flow };
  } catch (error) {
    return {
      ok: false as const,
      error:
        error instanceof Error ? error.message : "Could not complete Infisical authentication.",
    };
  }
}

export async function disconnectGoatInfisicalAuth() {
  const response = await (await serverApiClient()).v1["engine-auth"].infisical.$delete();
  if (!response.ok) {
    return {
      ok: false as const,
      error: await serverApiErrorMessage(response, "Could not disconnect Infisical."),
    };
  }
  revalidatePath("/settings");
  return { ok: true as const };
}
