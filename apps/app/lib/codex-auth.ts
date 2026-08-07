"use server";

import { getDb } from "@opencompany/db/client";
import { deleteCodexCredential } from "@opencompany/db/codex-auth";
import { codexCredentials } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";

export type CodexAuthSettings = {
  status: "connected" | "needs_reauth" | null;
  statusReason: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
};

export type CodexDeviceAuthFlow = {
  id: string;
  status: "pending" | "code_ready" | "completed" | "failed" | "expired";
  userCode: string | null;
  verificationUri: string | null;
  statusReason: string | null;
  expiresAt: string;
};

type RunnerFlowResponse = {
  ok: boolean;
  flow: CodexDeviceAuthFlow;
};

export async function loadCurrentCodexAuthSettings(): Promise<CodexAuthSettings> {
  const { user } = await currentUser();
  return loadCodexAuthSettingsForUser(user.workosUserId);
}

export async function loadCodexAuthSettingsForUser(
  userWorkosId: string,
): Promise<CodexAuthSettings> {
  const [row] = await getDb()
    .select({
      status: codexCredentials.status,
      statusReason: codexCredentials.statusReason,
      lastValidatedAt: codexCredentials.lastValidatedAt,
      lastRotatedAt: codexCredentials.lastRotatedAt,
    })
    .from(codexCredentials)
    .where(eq(codexCredentials.userWorkosId, userWorkosId))
    .limit(1);

  return {
    status: row?.status ?? null,
    statusReason: row?.statusReason ?? null,
    lastValidatedAt: row?.lastValidatedAt?.toISOString() ?? null,
    lastRotatedAt: row?.lastRotatedAt?.toISOString() ?? null,
  };
}

export async function isCodexConnectedForUser(userWorkosId: string) {
  const settings = await loadCodexAuthSettingsForUser(userWorkosId);
  return settings.status === "connected";
}

export async function startCodexDeviceAuth() {
  const { user } = await currentUser();
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

export async function pollCodexDeviceAuth(flowId: string) {
  const trimmedFlowId = flowId.trim();
  if (!trimmedFlowId) return { ok: false as const, error: "Codex auth flow is required." };

  const { user } = await currentUser();
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

export async function disconnectCodexAuth() {
  const { user } = await currentUser();
  await deleteCodexCredential({ db: getDb(), userWorkosId: user.workosUserId });
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
