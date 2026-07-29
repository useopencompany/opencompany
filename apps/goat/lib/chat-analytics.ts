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
}) {
  return captureGoatServerEvent(
    "chat_message_sent",
    input.user.workosUserId,
    {
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      is_first_message: input.isFirstMessage,
      engine: input.engine,
      model: input.model,
      message_length: input.messageLength,
    },
    {
      workspaceId: input.workspaceId,
      email: input.user.email,
      firstName: input.user.firstName,
      lastName: input.user.lastName,
    },
  );
}
