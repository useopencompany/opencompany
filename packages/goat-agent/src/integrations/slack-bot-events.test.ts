import { describe, expect, it } from "vitest";
import {
  GOAT_SLACK_BOT_EVENT_COMMAND_SCHEMA_VERSION,
  parseGoatSlackBotEventCommand,
} from "./slack-bot-events";

const command = {
  schemaVersion: GOAT_SLACK_BOT_EVENT_COMMAND_SCHEMA_VERSION,
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

describe("parseGoatSlackBotEventCommand", () => {
  it("accepts the versioned credential-free command", () => {
    expect(parseGoatSlackBotEventCommand(command)).toEqual(command);
  });

  it("rejects unknown versions, kinds, and malformed event inputs", () => {
    expect(parseGoatSlackBotEventCommand({ ...command, schemaVersion: 2 })).toBeNull();
    expect(parseGoatSlackBotEventCommand({ ...command, kind: "token" })).toBeNull();
    expect(
      parseGoatSlackBotEventCommand({ ...command, input: { ...command.input, channelId: "" } }),
    ).toBeNull();
  });
});
