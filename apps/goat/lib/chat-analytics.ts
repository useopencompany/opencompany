import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import type { GoatChatEngine } from "@opencompany/db/goat-schema";

type GoatChatAnalyticsUser = {
  workosUserId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
};

export function captureGoatChatMessageSent(input: {
  user: GoatChatAnalyticsUser;
  workspaceId: string;
  sessionId: string;
  isFirstMessage: boolean;
  engine: GoatChatEngine;
  model: string;
  messageLength: number;
  selectionMode?: "manual" | "auto";
  routingTier?: "standard" | "frontier";
  routingReason?: string;
  routingOutcome?: string;
  routingDurationMs?: number;
}) {
  return captureGoatServerEvent(
    "chat_message_sent",
    input.user.workosUserId,
    {
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      is_first_message: input.isFirstMessage,
      engine: input.engine,
      usage_source: goatAnalyticsUsageSourceForEngine(input.engine),
      model: input.model,
      message_length: input.messageLength,
      ...(input.selectionMode ? { selection_mode: input.selectionMode } : {}),
      ...(input.routingTier ? { routing_tier: input.routingTier } : {}),
      ...(input.routingReason ? { routing_reason: input.routingReason } : {}),
      ...(input.routingOutcome ? { routing_outcome: input.routingOutcome } : {}),
      ...(input.routingDurationMs !== undefined
        ? { routing_duration_ms: input.routingDurationMs }
        : {}),
    },
    {
      workspaceId: input.workspaceId,
      email: input.user.email,
      firstName: input.user.firstName,
      lastName: input.user.lastName,
    },
  );
}

function goatAnalyticsUsageSourceForEngine(engine: GoatChatEngine) {
  return engine === "opencompany" ? "owned_platform" : "external_harness";
}
