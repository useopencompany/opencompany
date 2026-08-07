import { captureServerEvent } from "@opencompany/analytics/server";
import type { ChatEngine } from "@opencompany/db/schema";

type ChatAnalyticsUser = {
  workosUserId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
};

export function captureChatMessageSent(input: {
  user: ChatAnalyticsUser;
  workspaceId: string;
  sessionId: string;
  isFirstMessage: boolean;
  engine: ChatEngine;
  model: string;
  messageLength: number;
  selectionMode?: "manual" | "auto";
  routingTier?: "standard" | "frontier";
  routingReason?: string;
  routingOutcome?: string;
  routingDurationMs?: number;
  routingErrorCategory?: string;
  routingFinishReason?: string;
  routingProviderStatusCode?: number;
  routingProviderRetryable?: boolean;
}) {
  return captureServerEvent(
    "chat_message_sent",
    input.user.workosUserId,
    {
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      is_first_message: input.isFirstMessage,
      engine: input.engine,
      usage_source: analyticsUsageSourceForEngine(input.engine),
      model: input.model,
      message_length: input.messageLength,
      ...(input.selectionMode ? { selection_mode: input.selectionMode } : {}),
      ...(input.routingTier ? { routing_tier: input.routingTier } : {}),
      ...(input.routingReason ? { routing_reason: input.routingReason } : {}),
      ...(input.routingOutcome ? { routing_outcome: input.routingOutcome } : {}),
      ...(input.routingDurationMs !== undefined
        ? { routing_duration_ms: input.routingDurationMs }
        : {}),
      ...(input.routingErrorCategory ? { routing_error_category: input.routingErrorCategory } : {}),
      ...(input.routingFinishReason ? { routing_finish_reason: input.routingFinishReason } : {}),
      ...(input.routingProviderStatusCode !== undefined
        ? { routing_provider_status_code: input.routingProviderStatusCode }
        : {}),
      ...(input.routingProviderRetryable !== undefined
        ? { routing_provider_retryable: input.routingProviderRetryable }
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

function analyticsUsageSourceForEngine(engine: ChatEngine) {
  return engine === "opencompany" ? "owned_platform" : "external_harness";
}
