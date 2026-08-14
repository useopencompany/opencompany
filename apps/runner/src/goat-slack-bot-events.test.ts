import {
  completeGoatSlackBotEvent,
  releaseGoatSlackBotEvent,
} from "@opencompany/db/goat-slack-bot";
import type { GoatSlackBotEventCommand } from "@opencompany/goat-agent/integrations/slack-bot-events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processGoatSlackBotMention } from "./goat-slack-bot-answer";
import { drainGoatSlackBotEvents, enqueueGoatSlackBotEvent } from "./goat-slack-bot-events";

vi.mock("@opencompany/db/goat-slack-bot", () => ({
  completeGoatSlackBotEvent: vi.fn(async () => undefined),
  releaseGoatSlackBotEvent: vi.fn(async () => undefined),
}));

vi.mock("./goat-slack-bot-answer", () => ({
  processGoatSlackBotDirectMessage: vi.fn(async () => undefined),
  processGoatSlackBotMention: vi.fn(async () => undefined),
  processGoatSlackBotThreadFollowUp: vi.fn(async () => undefined),
}));

const command: GoatSlackBotEventCommand = {
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
    enqueueGoatSlackBotEvent(command);
    await drainGoatSlackBotEvents();

    expect(processGoatSlackBotMention).toHaveBeenCalledWith(command.input);
    expect(completeGoatSlackBotEvent).toHaveBeenCalledWith({
      eventId: command.eventId,
      claimId: command.claimId,
    });
    expect(releaseGoatSlackBotEvent).not.toHaveBeenCalled();
  });

  it("releases the claim when answer processing fails", async () => {
    vi.mocked(processGoatSlackBotMention).mockRejectedValueOnce(new Error("gateway unavailable"));

    enqueueGoatSlackBotEvent(command);
    await drainGoatSlackBotEvents();

    expect(releaseGoatSlackBotEvent).toHaveBeenCalledWith({
      eventId: command.eventId,
      claimId: command.claimId,
    });
    expect(completeGoatSlackBotEvent).not.toHaveBeenCalled();
  });
});
