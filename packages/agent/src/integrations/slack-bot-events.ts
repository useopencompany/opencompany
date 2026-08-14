export const SLACK_BOT_EVENT_COMMAND_SCHEMA_VERSION = 1 as const;

export type SlackBotEventInput = {
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs: string | null;
  text: string;
  slackUserId: string;
};

export type SlackBotEventCommand = {
  schemaVersion: typeof SLACK_BOT_EVENT_COMMAND_SCHEMA_VERSION;
  eventId: string;
  claimId: string;
  kind: "mention" | "follow_up" | "dm";
  input: SlackBotEventInput;
};

export function parseSlackBotEventCommand(value: unknown): SlackBotEventCommand | null {
  if (!isRecord(value) || value.schemaVersion !== SLACK_BOT_EVENT_COMMAND_SCHEMA_VERSION) {
    return null;
  }
  if (
    !boundedString(value.eventId, 255) ||
    !boundedString(value.claimId, 255) ||
    (value.kind !== "mention" && value.kind !== "follow_up" && value.kind !== "dm") ||
    !isRecord(value.input)
  ) {
    return null;
  }
  const input = value.input;
  if (
    !boundedString(input.teamId, 255) ||
    !boundedString(input.channelId, 255) ||
    !boundedString(input.messageTs, 255) ||
    !(input.threadTs === null || boundedString(input.threadTs, 255)) ||
    typeof input.text !== "string" ||
    input.text.length > 100_000 ||
    !boundedString(input.slackUserId, 255)
  ) {
    return null;
  }
  return {
    schemaVersion: SLACK_BOT_EVENT_COMMAND_SCHEMA_VERSION,
    eventId: value.eventId,
    claimId: value.claimId,
    kind: value.kind,
    input: {
      teamId: input.teamId,
      channelId: input.channelId,
      messageTs: input.messageTs,
      threadTs: input.threadTs,
      text: input.text,
      slackUserId: input.slackUserId,
    },
  };
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
