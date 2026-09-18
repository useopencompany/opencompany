"use server";

import type { SlackBotWorkspaceSettingsDto } from "@opencompany/protocol";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";
import type { WorkspaceActionResult } from "@/lib/workspace-actions";

export async function getSlackBotWorkspaceSettingsAction(): Promise<SlackBotWorkspaceSettingsDto> {
  const response = await (await serverApiClient()).v1.workspace["slack-bot"].$get();
  if (!response.ok) {
    throw new Error(
      await serverApiErrorMessage(response, "Could not load the Slack bot connection."),
    );
  }
  return (await response.json()).data;
}

export async function disconnectSlackBotAction(): Promise<WorkspaceActionResult> {
  try {
    const response = await (await serverApiClient()).v1.workspace["slack-bot"].$delete();
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not disconnect the Slack bot."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not disconnect the Slack bot.",
    };
  }
}
