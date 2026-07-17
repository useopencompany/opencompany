"use client";

import type { GoatChatUiMessage } from "@/lib/chat-ui";
import { AssistantTextBubble } from "./AssistantTextBubble";
import { type ChatTaskLookup, getOrderedAssistantItems } from "./assistant-items";
import { ReasoningItem } from "./ReasoningItem";
import { TaskCard } from "./TaskCard";
import { TurnDuration } from "./ThinkingIndicator";
import { ToolCallItem } from "./ToolCallItem";
import { UserMessageBubble } from "./UserMessageBubble";

export function MessageBubble({
  message,
  taskLookup,
  stopped = false,
  durationMs,
}: {
  message: GoatChatUiMessage;
  taskLookup: ChatTaskLookup;
  stopped?: boolean;
  durationMs?: number | null | undefined;
}) {
  if (message.role === "user") {
    return <UserMessageBubble message={message} />;
  }
  return (
    <AssistantTurn
      message={message}
      taskLookup={taskLookup}
      stopped={stopped}
      durationMs={durationMs}
    />
  );
}

function AssistantTurn({
  message,
  taskLookup,
  stopped,
  durationMs,
}: {
  message: GoatChatUiMessage;
  taskLookup: ChatTaskLookup;
  stopped: boolean;
  durationMs?: number | null | undefined;
}) {
  const error = message.metadata?.error;
  const items = getOrderedAssistantItems(
    message,
    taskLookup,
    stopped || message.metadata?.aborted === true,
  );
  // Failed turns often end without any text part (sandbox start failure, disconnected auth);
  // the error must still get a bubble or the turn renders as nothing.
  const showStandaloneError = Boolean(error) && !items.some((item) => item.type === "text");

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => {
        if (item.type === "text") {
          return (
            <AssistantTextBubble
              key={item.key}
              text={item.text}
              citations={item.citations}
              {...(error ? { error } : {})}
            />
          );
        }
        if (item.type === "reasoning") return <ReasoningItem key={item.key} text={item.text} />;
        if (item.type === "task") return <TaskCard key={item.key} task={item.task} />;
        return <ToolCallItem key={item.key} tool={item.tool} />;
      })}
      {showStandaloneError && error ? <AssistantTextBubble text={error} error={error} /> : null}
      {typeof durationMs === "number" ? <TurnDuration durationMs={durationMs} /> : null}
    </div>
  );
}
