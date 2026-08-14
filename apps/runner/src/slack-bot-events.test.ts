import type { SlackBotEventCommand } from "@opencompany/agent/integrations/slack-bot-events";
import { completeSlackBotEvent, releaseSlackBotEvent } from "@opencompany/db/slack-bot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processSlackBotMention } from "./slack-bot-answer";
import { drainSlackBotEvents, enqueueSlackBotEvent } from "./slack-bot-events";

vi.mock("@opencompany/db/slack-bot", () => ({
  completeSlackBotEvent: vi.fn(async () => undefined),
  releaseSlackBotEvent: vi.fn(async () => undefined),
}));

vi.mock("./slack-bot-answer", () => ({
  processSlackBotDirectMessage: vi.fn(async () => undefined),
  processSlackBotMention: vi.fn(async () => undefined),
  processSlackBotThreadFollowUp: vi.fn(async () => undefined),
}));

const command: SlackBotEventCommand = {
  schemaVersion: 1,
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
};

describe("runner-owned Slack bot events", () => {
  beforeEach(() => vi.clearAllMocks());

  it("completes the durable claim after the answer is delivered", async () => {
    enqueueSlackBotEvent(command);
    await drainSlackBotEvents();

    expect(processSlackBotMention).toHaveBeenCalledWith(command.input);
    expect(completeSlackBotEvent).toHaveBeenCalledWith({
      eventId: command.eventId,
      claimId: command.claimId,
    });
    expect(releaseSlackBotEvent).not.toHaveBeenCalled();
  });

  it("releases the claim when answer processing fails", async () => {
    vi.mocked(processSlackBotMention).mockRejectedValueOnce(new Error("gateway unavailable"));

    enqueueSlackBotEvent(command);
    await drainSlackBotEvents();

    expect(releaseSlackBotEvent).toHaveBeenCalledWith({
      eventId: command.eventId,
      claimId: command.claimId,
    });
    expect(completeSlackBotEvent).not.toHaveBeenCalled();
  });
});
