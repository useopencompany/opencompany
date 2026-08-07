"use server";

import { getDb } from "@opencompany/db/client";
import { type McpClient, users } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { isMcpClient } from "@/lib/mcp-setup";

export type McpSetupActionResult = { ok: true } | { ok: false; error: string };

export async function savePreferredMcpClientAction(
  client: McpClient,
): Promise<McpSetupActionResult> {
  if (!isMcpClient(client)) {
    return { ok: false, error: "Choose a supported AI client." };
  }

  const { user } = await currentUser();
  try {
    await getDb()
      .update(users)
      .set({ preferredMcpClient: client, updatedAt: new Date() })
      .where(eq(users.workosUserId, user.workosUserId));
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    console.error("[goat] Could not save MCP client preference", {
      userWorkosId: user.workosUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "Could not save your AI client." };
  }
}

export async function checkMcpSetupStatusAction(): Promise<{
  complete: boolean;
  completedAt: string | null;
}> {
  const { user } = await currentUser();
  return {
    complete: Boolean(user.mcpSetupCompletedAt),
    completedAt: user.mcpSetupCompletedAt?.toISOString() ?? null,
  };
}
