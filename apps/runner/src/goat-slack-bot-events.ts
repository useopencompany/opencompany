import {
  completeGoatSlackBotEvent,
  releaseGoatSlackBotEvent,
} from "@opencompany/db/goat-slack-bot";
import type { GoatSlackBotEventCommand } from "@opencompany/goat-agent/integrations/slack-bot-events";
import { captureException, createLogger } from "@opencompany/observability";
import {
  processGoatSlackBotDirectMessage,
  processGoatSlackBotMention,
  processGoatSlackBotThreadFollowUp,
} from "./goat-slack-bot-answer";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-slack-bot-events",
});

const activeEvents = new Set<Promise<void>>();

export function enqueueGoatSlackBotEvent(command: GoatSlackBotEventCommand): void {
  const task = processClaimedEvent(command).finally(() => {
    activeEvents.delete(task);
  });
  activeEvents.add(task);
}

export function activeGoatSlackBotEventCount(): number {
  return activeEvents.size;
}

export async function drainGoatSlackBotEvents(): Promise<void> {
  await Promise.allSettled([...activeEvents]);
}

async function processClaimedEvent(command: GoatSlackBotEventCommand) {
  const claim = { eventId: command.eventId, claimId: command.claimId };
  try {
    if (command.kind === "mention") {
      await processGoatSlackBotMention(command.input);
    } else if (command.kind === "follow_up") {
      await processGoatSlackBotThreadFollowUp(command.input);
    } else {
      await processGoatSlackBotDirectMessage(command.input);
    }
  } catch (error) {
    await releaseGoatSlackBotEvent(claim).catch((releaseError) => {
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
      event: "opencompany.goat_slack_bot_event_failed",
      event_id: command.eventId,
      kind: command.kind,
    });
    return;
  }

  await completeGoatSlackBotEvent(claim).catch((error) => {
    // Keep the live lease if completion persistence fails. Releasing it after
    // an answer was posted would let a Slack retry double-post immediately.
    logger.error("Failed to complete Slack bot event claim", {
      event: "goat.slack_bot_event_completion_failed",
      event_id: command.eventId,
      error_message: errorMessage(error),
    });
    captureException(error, {
      event: "opencompany.goat_slack_bot_event_completion_failed",
      event_id: command.eventId,
    });
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
