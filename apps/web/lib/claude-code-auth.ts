"use server";

import { isClaudeCodeConnectedForUser as readClaudeCodeConnectionForUser } from "@opencompany/agent/application/engine-auth-status";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiError, serverApiErrorMessage } from "@/lib/server-api-client";

export type ClaudeCodeAuthSettings = {
  status: "connected" | "needs_reauth" | null;
  statusReason: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
};

export async function loadCurrentClaudeCodeAuthSettings(): Promise<ClaudeCodeAuthSettings> {
  const response = await (await serverApiClient()).v1["engine-auth"]["claude-code"].$get();
  if (!response.ok) {
    throw await serverApiError(response, "Could not load the Claude Code connection.");
  }
  return (await response.json()).data as ClaudeCodeAuthSettings;
}

export async function isClaudeCodeConnectedForUser(userWorkosId: string) {
  return readClaudeCodeConnectionForUser(userWorkosId);
}

export async function saveClaudeCodeToken(token: string) {
  try {
    const response = await (await serverApiClient()).v1["engine-auth"]["claude-code"].$put({
      json: { token },
    });
    if (!response.ok) {
      return {
        ok: false as const,
        error: await serverApiErrorMessage(response, "Could not save the Claude Code token."),
      };
    }
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not save the Claude Code token.",
    };
  }
  revalidatePath("/settings");
  return { ok: true as const };
}

export async function disconnectClaudeCodeAuth() {
  const response = await (await serverApiClient()).v1["engine-auth"]["claude-code"].$delete();
  if (!response.ok) {
    throw await serverApiError(response, "Could not disconnect Claude Code.");
  }
  revalidatePath("/settings");
  return { ok: true as const };
}
