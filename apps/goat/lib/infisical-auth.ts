"use server";

import { getDb } from "@opencompany/db/client";
import {
  disconnectGoatInfisicalConnection,
  loadGoatInfisicalConnectionMetadata,
} from "@opencompany/db/goat-infisical-auth";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";

export type GoatInfisicalAuthSettings = {
  status: "connected" | "needs_reauth" | "disconnected" | null;
  statusReason: string | null;
  accountEmail: string | null;
  lastValidatedAt: string | null;
};

export type GoatInfisicalAuthFlow = {
  id: string;
  status: "pending" | "link_ready" | "completed" | "failed" | "expired";
  loginUrl: string | null;
  statusReason: string | null;
  expiresAt: string;
};

type RunnerFlowResponse = { ok: boolean; flow: GoatInfisicalAuthFlow };

export async function loadCurrentGoatInfisicalAuthSettings(): Promise<GoatInfisicalAuthSettings> {
  const { workspace } = await currentGoatUser();
  const connection = await loadGoatInfisicalConnectionMetadata({
    db: getDb(),
    workspaceId: workspace.id,
  });
  return {
    status: connection?.status ?? null,
    statusReason: connection?.statusReason ?? null,
    accountEmail: connection?.accountEmail ?? null,
    lastValidatedAt: connection?.lastValidatedAt?.toISOString() ?? null,
  };
}

export async function startGoatInfisicalAuth() {
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  try {
    const response = await callRunnerJson<RunnerFlowResponse>(
      "/internal/goat/infisical-auth/start",
      {
        workspaceId: gate.workspaceId,
        requestedByWorkosId: gate.userWorkosId,
      },
    );
    return { ok: true as const, flow: response.flow };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not start Infisical authentication.",
    };
  }
}

export async function completeGoatInfisicalAuth(input: { flowId: string; browserToken: string }) {
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  const flowId = input.flowId.trim();
  const browserToken = input.browserToken.trim();
  if (!flowId || !browserToken) {
    return { ok: false as const, error: "Paste the browser token from Infisical." };
  }
  if (browserToken.length > 64 * 1024) {
    return { ok: false as const, error: "That Infisical browser token is too large." };
  }
  try {
    const response = await callRunnerJson<RunnerFlowResponse>(
      `/internal/goat/infisical-auth/${encodeURIComponent(flowId)}/complete`,
      {
        workspaceId: gate.workspaceId,
        requestedByWorkosId: gate.userWorkosId,
        browserToken,
      },
    );
    if (response.flow.status === "completed") revalidatePath("/settings");
    return { ok: true as const, flow: response.flow };
  } catch (error) {
    return {
      ok: false as const,
      error:
        error instanceof Error ? error.message : "Could not complete Infisical authentication.",
    };
  }
}

export async function disconnectGoatInfisicalAuth() {
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  await disconnectGoatInfisicalConnection({ db: getDb(), workspaceId: gate.workspaceId });
  revalidatePath("/settings");
  return { ok: true as const };
}

async function requireWorkspaceAdmin(): Promise<
  { ok: false; error: string } | { ok: true; workspaceId: string; userWorkosId: string }
> {
  const context = await currentGoatUser({ optional: true });
  if (!context) return { ok: false, error: "You must be signed in." };
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can manage Infisical." };
  }
  return {
    ok: true,
    workspaceId: context.workspace.id,
    userWorkosId: context.user.workosUserId,
  };
}

async function callRunnerJson<TResponse>(path: string, body: Record<string, unknown>) {
  const baseUrl = runnerInternalBaseUrl();
  const token = runnerToken();
  if (!baseUrl || !token) throw new Error("Runner is not configured.");

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const reason = typeof payload?.error === "string" ? payload.error : "Runner request failed.";
    throw new Error(reason);
  }
  return (await response.json()) as TResponse;
}

function runnerInternalBaseUrl() {
  const internalUrl = process.env.RUNNER_INTERNAL_URL?.trim();
  const publicUrl = process.env.RUNNER_PUBLIC_URL?.trim();
  return (internalUrl || publicUrl)?.replace(/\/+$/, "");
}

function runnerToken() {
  return process.env.RUNNER_INTERNAL_TOKEN?.trim();
}
