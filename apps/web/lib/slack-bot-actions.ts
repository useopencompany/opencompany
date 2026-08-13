"use server";

import type { SlackBotChannelDto, SlackBotDestinationDto } from "@opencompany/protocol";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";
import type { GoatWorkspaceActionResult } from "@/lib/workspace-actions";

type GoatSlackConversationRef = Pick<SlackBotChannelDto, "id" | "name">;

export type GoatSlackBotChannel = SlackBotChannelDto;

export type GoatSlackBotChannelListResult =
  | { ok: true; channels: GoatSlackBotChannel[]; partial: boolean }
  | { ok: false; error: string };

export type GoatSlackBotDestinationView = SlackBotDestinationDto;

export async function disconnectGoatSlackBotAction(): Promise<GoatWorkspaceActionResult> {
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

export async function listGoatSlackBotChannelsAction(
  brainRef: string,
): Promise<GoatSlackBotChannelListResult> {
  try {
    const response = await (await serverApiClient()).v1.brains[":brainId"][
      "slack-bot"
    ].channels.$get({
      param: { brainId: brainRef },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not load channels from Slack."),
      };
    }
    const result = (await response.json()).data;
    return { ok: true, channels: result.channels, partial: result.partial };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not load channels from Slack.",
    };
  }
}

export async function getGoatBrainSlackBotDestinationAction(
  brainRef: string,
): Promise<GoatSlackBotDestinationView | null> {
  const response = await (await serverApiClient()).v1.brains[":brainId"]["slack-bot"].$get({
    param: { brainId: brainRef },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(await serverApiErrorMessage(response, "Could not load the Slack destination."));
  }
  return (await response.json()).data;
}

export async function setGoatBrainSlackBotDestinationAction(input: {
  brainRef: string;
  enabled: boolean;
  channels: GoatSlackConversationRef[];
}): Promise<GoatWorkspaceActionResult> {
  try {
    const response = await (await serverApiClient()).v1.brains[":brainId"]["slack-bot"].$put({
      param: { brainId: input.brainRef },
      json: { enabled: input.enabled, channels: input.channels },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not update the Slack bot destination."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the Slack bot destination.",
    };
  }
}
