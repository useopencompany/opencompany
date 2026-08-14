import { describe, expect, it } from "vitest";
import {
  parseSlackBotEventCommand,
  SLACK_BOT_EVENT_COMMAND_SCHEMA_VERSION,
} from "./slack-bot-events";

const command = {
  schemaVersion: SLACK_BOT_EVENT_COMMAND_SCHEMA_VERSION,
  eventId: "Ev123",
  claimId: "gsbec_claim",
  kind: "mention",
  input: {
    teamId: "T123",
    channelId: "C123",
    messageTs: "1784196000.000100",
    threadTs: null,
    text: "<@B123> what changed?",
    slackUserId: "U123",
  },
} as const;

describe("parseSlackBotEventCommand", () => {
  it("accepts the versioned credential-free command", () => {
    expect(parseSlackBotEventCommand(command)).toEqual(command);
  });

  it("rejects unknown versions, kinds, and malformed event inputs", () => {
    expect(parseSlackBotEventCommand({ ...command, schemaVersion: 2 })).toBeNull();
    expect(parseSlackBotEventCommand({ ...command, kind: "token" })).toBeNull();
    expect(
      parseSlackBotEventCommand({ ...command, input: { ...command.input, channelId: "" } }),
    ).toBeNull();
  });
});
