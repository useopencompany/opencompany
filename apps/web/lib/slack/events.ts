import { inngest } from "@/lib/inngest/client";

export const SLACK_SUPPORT_CHANNEL_REQUESTED_EVENT = "slack.support_channel_requested";

export type SlackSupportChannelRequestedEventData = {
  workspaceId: string;
  userId: string;
  customerEmail: string;
  firstName?: string | null;
};

export function dispatchSlackSupportChannelRequested(input: SlackSupportChannelRequestedEventData) {
  return inngest.send({ name: SLACK_SUPPORT_CHANNEL_REQUESTED_EVENT, data: input });
}
