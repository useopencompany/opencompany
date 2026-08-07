"use server";

import { getDb } from "@opencompany/db/client";
import { deleteGoatCodexCredential } from "@opencompany/db/codex-auth";
import { goatCodexCredentials } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";

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

type RunnerFlowResponse = {
  ok: boolean;
  flow: GoatCodexDeviceAuthFlow;
};

export async function loadCurrentGoatCodexAuthSettings(): Promise<GoatCodexAuthSettings> {
  const { user } = await currentGoatUser();
  return loadGoatCodexAuthSettingsForUser(user.workosUserId);
}

export async function loadGoatCodexAuthSettingsForUser(
  userWorkosId: string,
): Promise<GoatCodexAuthSettings> {
  const [row] = await getDb()
    .select({
      status: goatCodexCredentials.status,
      statusReason: goatCodexCredentials.statusReason,
      lastValidatedAt: goatCodexCredentials.lastValidatedAt,
      lastRotatedAt: goatCodexCredentials.lastRotatedAt,
    })
    .from(goatCodexCredentials)
    .where(eq(goatCodexCredentials.userWorkosId, userWorkosId))
    .limit(1);

  return {
    status: row?.status ?? null,
    statusReason: row?.statusReason ?? null,
    lastValidatedAt: row?.lastValidatedAt?.toISOString() ?? null,
    lastRotatedAt: row?.lastRotatedAt?.toISOString() ?? null,
  };
}

export async function isGoatCodexConnectedForUser(userWorkosId: string) {
  const settings = await loadGoatCodexAuthSettingsForUser(userWorkosId);
  return settings.status === "connected";
}

export async function startGoatCodexDeviceAuth() {
  const { user } = await currentGoatUser();
  try {
    const response = await callRunnerJson<RunnerFlowResponse>(
      "/internal/goat/codex-auth/device/start",
      { userWorkosId: user.workosUserId },
    );
    return { ok: true as const, flow: response.flow };
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

  const { user } = await currentGoatUser();
  try {
    const response = await callRunnerJson<RunnerFlowResponse>(
      `/internal/goat/codex-auth/device/${encodeURIComponent(trimmedFlowId)}/poll`,
      { userWorkosId: user.workosUserId },
    );
    if (response.flow.status === "completed") revalidatePath("/settings");
    return { ok: true as const, flow: response.flow };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not check Codex authentication.",
    };
  }
}

export async function disconnectGoatCodexAuth() {
  const { user } = await currentGoatUser();
  await deleteGoatCodexCredential({ db: getDb(), userWorkosId: user.workosUserId });
  revalidatePath("/settings");
  return { ok: true as const };
}

async function callRunnerJson<TResponse>(path: string, body: Record<string, unknown>) {
  const baseUrl = runnerInternalBaseUrl();
  const token = runnerToken();
  if (!baseUrl || !token) {
    throw new Error("Runner is not configured.");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Runner request failed with ${response.status}: ${details}`);
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
