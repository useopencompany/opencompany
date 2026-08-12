import type { GoatSlackConversationRef } from "@opencompany/db/goat-slack";
import { slackApiRequest } from "./slack";

export type GoatSlackChannelOption = GoatSlackConversationRef & {
  isPrivate: boolean;
  isSlackConnect: boolean;
};

export type GoatSlackDmOption = GoatSlackConversationRef & {
  isSlackConnect: boolean;
};

export type GoatSlackConversationOptions = {
  channels: GoatSlackChannelOption[];
  dms: GoatSlackDmOption[];
  partial: boolean;
};

type SlackConversation = {
  id?: string;
  name?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_ext_shared?: boolean;
};

type SlackUser = {
  id?: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string };
};

type SlackApiRequestInput = {
  method: string;
  token?: string;
  form?: Record<string, string>;
  signal?: AbortSignal;
};

export type SlackApiRequester = <T extends Record<string, unknown>>(
  input: SlackApiRequestInput,
) => Promise<T>;

export async function listGoatSlackConversationOptions(input: {
  token: string;
  teamId: string;
  authedUserId: string;
  request?: SlackApiRequester;
}): Promise<GoatSlackConversationOptions> {
  const request = input.request ?? slackApiRequest;
  const channels: GoatSlackChannelOption[] = [];
  const dms: GoatSlackDmOption[] = [];
  const ims: SlackConversation[] = [];
  let cursor: string | undefined;
  let partial = false;

  try {
    do {
      const page = await request<{
        channels?: SlackConversation[];
        response_metadata?: { next_cursor?: string };
      }>({
        method: "users.conversations",
        token: input.token,
        form: {
          types: "public_channel,private_channel,mpim,im",
          exclude_archived: "true",
          limit: "200",
          ...(cursor ? { cursor } : {}),
        },
      });
      for (const conversation of page.channels ?? []) {
        if (!conversation.id || conversation.is_archived) continue;
        if (conversation.is_im) {
          ims.push(conversation);
        } else if (conversation.is_mpim) {
          dms.push({
            id: conversation.id,
            name: conversation.name?.trim() || conversation.id,
            isSlackConnect: conversation.is_ext_shared ?? false,
          });
        } else {
          channels.push({
            id: conversation.id,
            name: conversation.name?.trim() || conversation.id,
            isPrivate: conversation.is_private ?? false,
            isSlackConnect: conversation.is_ext_shared ?? false,
          });
        }
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch {
    // Rate limits or transient Slack errors should not make already loaded
    // conversations disappear from the picker.
    partial = true;
  }

  for (const conversation of ims) {
    const conversationId = conversation.id!;
    let slackUserId = conversation.user;

    // Slack normally includes `user` on an IM. Keep Slack Connect DMs usable
    // when that limited conversation object omits it by resolving membership.
    if (!slackUserId) {
      try {
        const result = await request<{ members?: string[] }>({
          method: "conversations.members",
          token: input.token,
          form: { channel: conversationId, limit: "10" },
        });
        slackUserId = result.members?.find((memberId) => memberId !== input.authedUserId);
      } catch {
        partial = true;
      }
    }

    if (!slackUserId) {
      dms.push({
        id: conversationId,
        name: conversation.name?.trim() || conversationId,
        isSlackConnect: conversation.is_ext_shared ?? false,
      });
      partial = true;
      continue;
    }

    try {
      const result = await request<{ user?: SlackUser }>({
        method: "users.info",
        token: input.token,
        form: { user: slackUserId },
      });
      const user = result.user;
      dms.push({
        id: conversationId,
        name:
          user?.profile?.display_name?.trim() ||
          user?.real_name?.trim() ||
          user?.name?.trim() ||
          slackUserId,
        isSlackConnect:
          Boolean(conversation.is_ext_shared) ||
          Boolean(user?.team_id && input.teamId && user.team_id !== input.teamId),
      });
    } catch {
      dms.push({
        id: conversationId,
        name: conversation.name?.trim() || slackUserId,
        isSlackConnect: conversation.is_ext_shared ?? false,
      });
      partial = true;
    }
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));
  dms.sort((a, b) => a.name.localeCompare(b.name));
  return { channels, dms, partial };
}
