"use server";

import { getDb } from "@opencompany/db/client";
import { type GoatMcpClient, goatUsers } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { isGoatMcpClient } from "@/lib/mcp-setup";

export type GoatMcpSetupActionResult = { ok: true } | { ok: false; error: string };

export async function savePreferredGoatMcpClientAction(
  client: GoatMcpClient,
): Promise<GoatMcpSetupActionResult> {
  if (!isGoatMcpClient(client)) {
    return { ok: false, error: "Choose a supported AI client." };
  }

  const { user } = await currentGoatUser();
  try {
    await getDb()
      .update(goatUsers)
      .set({ preferredMcpClient: client, updatedAt: new Date() })
      .where(eq(goatUsers.workosUserId, user.workosUserId));
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

export async function checkGoatMcpSetupStatusAction(): Promise<{
  complete: boolean;
  completedAt: string | null;
}> {
  const { user } = await currentGoatUser();
  return {
    complete: Boolean(user.mcpSetupCompletedAt),
    completedAt: user.mcpSetupCompletedAt?.toISOString() ?? null,
  };
}
