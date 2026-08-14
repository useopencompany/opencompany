"use server";

import { revalidatePath } from "next/cache";
import { isMcpClient, type McpClient } from "@/lib/mcp-setup";
import { serverApiClient, serverApiError } from "@/lib/server-api-client";

export type McpSetupActionResult = { ok: true } | { ok: false; error: string };

export async function savePreferredMcpClientAction(
  client: McpClient,
): Promise<McpSetupActionResult> {
  if (!isMcpClient(client)) {
    return { ok: false, error: "Choose a supported AI client." };
  }

  try {
    const response = await (await serverApiClient()).v1.me["mcp-setup"].$patch({
      json: { preferredClient: client },
    });
    if (!response.ok) {
      throw await serverApiError(response, "Could not save your AI client.");
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    console.error("[opencompany] Could not save MCP client preference", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "Could not save your AI client." };
  }
}

export async function checkMcpSetupStatusAction(): Promise<{
  complete: boolean;
  completedAt: string | null;
}> {
  const response = await (await serverApiClient()).v1.me["mcp-setup"].$get();
  if (!response.ok) {
    throw await serverApiError(response, "MCP setup status could not be loaded.");
  }
  const status = (await response.json()).data;
  return { complete: status.complete, completedAt: status.completedAt };
}
