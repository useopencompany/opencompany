"use server";

import { isGoatClaudeCodeConnectedForUser as readGoatClaudeCodeConnectionForUser } from "@opencompany/goat-agent/application/engine-auth-status";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiError, serverApiErrorMessage } from "@/lib/server-api-client";

export type GoatClaudeCodeAuthSettings = {
  status: "connected" | "needs_reauth" | null;
  statusReason: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
};

export async function loadCurrentGoatClaudeCodeAuthSettings(): Promise<GoatClaudeCodeAuthSettings> {
  const response = await (await serverApiClient()).v1["engine-auth"]["claude-code"].$get();
  if (!response.ok) {
    throw await serverApiError(response, "Could not load the Claude Code connection.");
  }
  return (await response.json()).data as GoatClaudeCodeAuthSettings;
}

export async function isGoatClaudeCodeConnectedForUser(userWorkosId: string) {
  return readGoatClaudeCodeConnectionForUser(userWorkosId);
}

export async function saveGoatClaudeCodeToken(token: string) {
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

export async function disconnectGoatClaudeCodeAuth() {
  const response = await (await serverApiClient()).v1["engine-auth"]["claude-code"].$delete();
  if (!response.ok) {
    throw await serverApiError(response, "Could not disconnect Claude Code.");
  }
  revalidatePath("/settings");
  return { ok: true as const };
}
