import type { SlackBotEventCommand } from "@opencompany/agent/integrations/slack-bot-events";
import { completeSlackBotEvent, releaseSlackBotEvent } from "@opencompany/db/slack-bot";
import { captureException, createLogger } from "@opencompany/observability";
import {
  processSlackBotDirectMessage,
  processSlackBotMention,
  processSlackBotThreadFollowUp,
} from "./slack-bot-answer";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-slack-bot-events",
});

const activeEvents = new Set<Promise<void>>();

export function enqueueSlackBotEvent(command: SlackBotEventCommand): void {
  const task = processClaimedEvent(command).finally(() => {
    activeEvents.delete(task);
  });
  activeEvents.add(task);
}

export function activeSlackBotEventCount(): number {
  return activeEvents.size;
}

export async function drainSlackBotEvents(): Promise<void> {
  await Promise.allSettled([...activeEvents]);
}

async function processClaimedEvent(command: SlackBotEventCommand) {
  const claim = { eventId: command.eventId, claimId: command.claimId };
  try {
    if (command.kind === "mention") {
      await processSlackBotMention(command.input);
    } else if (command.kind === "follow_up") {
      await processSlackBotThreadFollowUp(command.input);
    } else {
      await processSlackBotDirectMessage(command.input);
    }
  } catch (error) {
    await releaseSlackBotEvent(claim).catch((releaseError) => {
      logger.error("Failed to release Slack bot event claim", {
        event: "goat.slack_bot_event_release_failed",
        event_id: command.eventId,
        error_message: errorMessage(releaseError),
      });
    });
    logger.error("Slack bot event processing failed", {
      event: "goat.slack_bot_event_failed",
      event_id: command.eventId,
      kind: command.kind,
      team_id: command.input.teamId,
      channel_id: command.input.channelId,
      error_message: errorMessage(error),
    });
    captureException(error, {
      event: "goat.slack_bot_event_failed",
      event_id: command.eventId,
      kind: command.kind,
    });
    return;
  }

  await completeSlackBotEvent(claim).catch((error) => {
    // Keep the live lease if completion persistence fails. Releasing it after
    // an answer was posted would let a Slack retry double-post immediately.
    logger.error("Failed to complete Slack bot event claim", {
      event: "goat.slack_bot_event_completion_failed",
      event_id: command.eventId,
      error_message: errorMessage(error),
    });
    captureException(error, {
      event: "goat.slack_bot_event_completion_failed",
      event_id: command.eventId,
    });
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
