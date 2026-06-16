"use server";

import { revalidatePath } from "next/cache";
import { currentWorkspace } from "@/lib/auth";
import { createPersonalMcpToken, revokePersonalMcpToken } from "@/lib/personal/mcp-tokens";

type CreatePersonalMcpTokenResult =
  | {
      ok: true;
      token: string;
      summary: Awaited<ReturnType<typeof createPersonalMcpToken>>["summary"];
    }
  | { ok: false; error: string };

export async function createPersonalMcpTokenAction(
  label?: string,
): Promise<CreatePersonalMcpTokenResult> {
  try {
    const { workspace, user } = await currentWorkspace();
    const result = await createPersonalMcpToken({
      workspaceId: workspace.id,
      userId: user.id,
      ...(label !== undefined ? { label } : {}),
    });
    revalidatePath("/personal/settings");
    return { ok: true, token: result.token, summary: result.summary };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not create MCP token.",
    };
  }
}

export async function revokePersonalMcpTokenAction(
  tokenId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { workspace, user } = await currentWorkspace();
    await revokePersonalMcpToken({ workspaceId: workspace.id, userId: user.id, tokenId });
    revalidatePath("/personal/settings");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not revoke MCP token.",
    };
  }
}
