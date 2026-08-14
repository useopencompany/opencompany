"use server";

import { isGoatCodexConnectedForUser as readGoatCodexConnectionForUser } from "@opencompany/goat-agent/application/engine-auth-status";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiError, serverApiErrorMessage } from "@/lib/server-api-client";

export type GoatCodexAuthSettings = {
  status: "connected" | "needs_reauth" | null;
  statusReason: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
};

export type GoatCodexDeviceAuthFlow = {
  id: string;
  status: "pending" | "code_ready" | "completed" | "failed" | "expired";
  userCode: string | null;
  verificationUri: string | null;
  statusReason: string | null;
  expiresAt: string;
};

export async function loadCurrentGoatCodexAuthSettings(): Promise<GoatCodexAuthSettings> {
  const response = await (await serverApiClient()).v1["engine-auth"].codex.$get();
  if (!response.ok) {
    throw await serverApiError(response, "Could not load the Codex connection.");
  }
  return (await response.json()).data as GoatCodexAuthSettings;
}

export async function isGoatCodexConnectedForUser(userWorkosId: string) {
  return readGoatCodexConnectionForUser(userWorkosId);
}

export async function startGoatCodexDeviceAuth() {
  try {
    const response = await (await serverApiClient()).v1["engine-auth"].codex.device.$post();
    if (!response.ok) {
      return {
        ok: false as const,
        error: await serverApiErrorMessage(response, "Could not start Codex authentication."),
      };
    }
    const data = (await response.json()).data as { flow: GoatCodexDeviceAuthFlow };
    return { ok: true as const, flow: data.flow };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not start Codex authentication.",
    };
  }
}

export async function pollGoatCodexDeviceAuth(flowId: string) {
  const trimmedFlowId = flowId.trim();
  if (!trimmedFlowId) return { ok: false as const, error: "Codex auth flow is required." };

  try {
    const response = await (await serverApiClient()).v1["engine-auth"].codex.device[
      ":flowId"
    ].poll.$post({ param: { flowId: trimmedFlowId } });
    if (!response.ok) {
      return {
        ok: false as const,
        error: await serverApiErrorMessage(response, "Could not check Codex authentication."),
      };
    }
    const data = (await response.json()).data as { flow: GoatCodexDeviceAuthFlow };
    if (data.flow.status === "completed") revalidatePath("/settings");
    return { ok: true as const, flow: data.flow };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not check Codex authentication.",
    };
  }
}

export async function disconnectGoatCodexAuth() {
  const response = await (await serverApiClient()).v1["engine-auth"].codex.$delete();
  if (!response.ok) {
    throw await serverApiError(response, "Could not disconnect Codex.");
  }
  revalidatePath("/settings");
  return { ok: true as const };
}
