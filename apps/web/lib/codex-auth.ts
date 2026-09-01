"use server";

import { isCodexConnectedForUser as readCodexConnectionForUser } from "@opencompany/agent/application/engine-auth-status";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiError, serverApiErrorMessage } from "@/lib/server-api-client";

export type CodexAuthSettings = {
  status: "connected" | "needs_reauth" | null;
  statusReason: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
  workspaceEngine: {
    enabled: boolean;
    providerEmail: string | null;
    providerName: string | null;
    credentialStatus: "connected" | "needs_reauth" | null;
    statusReason: string | null;
    updatedAt: string | null;
  };
};

export type CodexDeviceAuthFlow = {
  id: string;
  status: "pending" | "code_ready" | "completed" | "failed" | "expired";
  userCode: string | null;
  verificationUri: string | null;
  statusReason: string | null;
  expiresAt: string;
};

export async function loadCurrentCodexAuthSettings(): Promise<CodexAuthSettings> {
  const response = await (await serverApiClient()).v1["engine-auth"].codex.$get();
  if (!response.ok) {
    throw await serverApiError(response, "Could not load the Codex connection.");
  }
  return (await response.json()).data as CodexAuthSettings;
}

export async function isCodexConnectedForUser(userWorkosId: string) {
  return readCodexConnectionForUser(userWorkosId);
}

export async function startCodexDeviceAuth() {
  try {
    const response = await (await serverApiClient()).v1["engine-auth"].codex.device.$post();
    if (!response.ok) {
      return {
        ok: false as const,
        error: await serverApiErrorMessage(response, "Could not start Codex authentication."),
      };
    }
    const data = (await response.json()).data as { flow: CodexDeviceAuthFlow };
    return { ok: true as const, flow: data.flow };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not start Codex authentication.",
    };
  }
}

export async function pollCodexDeviceAuth(flowId: string) {
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
    const data = (await response.json()).data as { flow: CodexDeviceAuthFlow };
    if (data.flow.status === "completed") revalidatePath("/settings");
    return { ok: true as const, flow: data.flow };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not check Codex authentication.",
    };
  }
}

export async function disconnectCodexAuth() {
  const response = await (await serverApiClient()).v1["engine-auth"].codex.$delete();
  if (!response.ok) {
    throw await serverApiError(response, "Could not disconnect Codex.");
  }
  revalidatePath("/settings");
  return { ok: true as const };
}

export async function setWorkspaceCodexEngineEnabled(enabled: boolean) {
  try {
    const response = await (await serverApiClient()).v1["engine-auth"].codex.workspace.$put({
      json: { enabled },
    });
    if (!response.ok) {
      return {
        ok: false as const,
        error: await serverApiErrorMessage(
          response,
          "Could not update the workspace Codex engine.",
        ),
      };
    }
    revalidatePath("/settings");
    return { ok: true as const, settings: (await response.json()).data as CodexAuthSettings };
  } catch (error) {
    return {
      ok: false as const,
      error:
        error instanceof Error ? error.message : "Could not update the workspace Codex engine.",
    };
  }
}
