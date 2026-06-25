"use server";

import { getDb } from "@opencompany/db/client";
import { deleteWorkspaceCodexCredential } from "@opencompany/db/codex-auth";
import { createLogger } from "@opencompany/observability";
import { revalidatePath } from "next/cache";
import { callRunnerJson } from "@/lib/agent-sessions/runner";
import { AUTHENTICATION_REQUIRED_MESSAGE, currentWorkspace } from "@/lib/auth";

const logger = createLogger({ service: "opencompany-web", runtime: "codex-auth" });

export type CodexDeviceAuthFlow = {
  id: string;
  status: "pending" | "code_ready" | "completed" | "failed" | "expired";
  userCode: string | null;
  verificationUri: string | null;
  statusReason: string | null;
  expiresAt: string;
};

type RunnerFlowResponse = {
  ok: true;
  flow: CodexDeviceAuthFlow;
};

export async function startWorkspaceCodexDeviceAuth() {
  const context = await currentWorkspace({ optional: true, requireAdmin: true });
  if (!context) return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };

  try {
    logger.info("Starting workspace Codex auth flow", {
      event: "opencompany.codex_auth_start_requested",
      workspace_id: context.workspace.id,
      user_id: context.user.id,
    });
    const response = await callRunnerJson<RunnerFlowResponse>("/internal/codex-auth/device/start", {
      body: {
        workspaceId: context.workspace.id,
        requestedByUserId: context.user.id,
      },
      context: {
        workspace_id: context.workspace.id,
        event: "opencompany.codex_auth_start_failed",
      },
    });
    logger.info("Workspace Codex auth flow started", {
      event: "opencompany.codex_auth_start_succeeded",
      workspace_id: context.workspace.id,
      flow_id: response.flow.id,
      flow_status: response.flow.status,
    });
    revalidatePath("/company/settings");
    return { ok: true as const, flow: response.flow };
  } catch (error) {
    logger.warn("Workspace Codex auth flow start failed", {
      event: "opencompany.codex_auth_start_failed",
      workspace_id: context.workspace.id,
      error,
    });
    return {
      ok: false as const,
      error:
        error instanceof Error ? error.message : "Could not start Codex device authentication.",
    };
  }
}

export async function pollWorkspaceCodexDeviceAuth(flowId: string) {
  const context = await currentWorkspace({ optional: true, requireAdmin: true });
  if (!context) return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };

  const trimmedFlowId = flowId.trim();
  if (!trimmedFlowId) return { ok: false as const, error: "Codex auth flow is required." };

  try {
    logger.debug("Polling workspace Codex auth flow", {
      event: "opencompany.codex_auth_poll_requested",
      workspace_id: context.workspace.id,
      flow_id: trimmedFlowId,
    });
    const response = await callRunnerJson<RunnerFlowResponse>(
      `/internal/codex-auth/device/${encodeURIComponent(trimmedFlowId)}/poll`,
      {
        body: { workspaceId: context.workspace.id },
        context: {
          workspace_id: context.workspace.id,
          event: "opencompany.codex_auth_poll_failed",
        },
      },
    );
    logger.debug("Workspace Codex auth flow poll succeeded", {
      event: "opencompany.codex_auth_poll_succeeded",
      workspace_id: context.workspace.id,
      flow_id: response.flow.id,
      flow_status: response.flow.status,
      has_user_code: Boolean(response.flow.userCode),
      has_verification_uri: Boolean(response.flow.verificationUri),
    });
    if (response.flow.status === "completed") revalidatePath("/company/settings");
    return { ok: true as const, flow: response.flow };
  } catch (error) {
    logger.warn("Workspace Codex auth flow poll failed", {
      event: "opencompany.codex_auth_poll_failed",
      workspace_id: context.workspace.id,
      flow_id: trimmedFlowId,
      error,
    });
    return {
      ok: false as const,
      error:
        error instanceof Error ? error.message : "Could not check Codex device authentication.",
    };
  }
}

export async function disconnectWorkspaceCodexAuth() {
  const context = await currentWorkspace({ optional: true, requireAdmin: true });
  if (!context) return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };

  await deleteWorkspaceCodexCredential({ db: getDb(), workspaceId: context.workspace.id });
  revalidatePath("/company/settings");
  return { ok: true as const };
}
