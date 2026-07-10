"use client";

import type { GoatChatUiMessage } from "@/lib/chat-ui";
import { AssistantTextBubble } from "./AssistantTextBubble";
import { type ChatTaskLookup, getOrderedAssistantItems } from "./assistant-items";
import { ReasoningItem } from "./ReasoningItem";
import { TaskCard } from "./TaskCard";
import { ToolCallItem } from "./ToolCallItem";
import { UserMessageBubble } from "./UserMessageBubble";

export function MessageBubble({
  message,
  taskLookup,
  stopped = false,
}: {
  message: GoatChatUiMessage;
  taskLookup: ChatTaskLookup;
  stopped?: boolean;
}) {
  if (message.role === "user") {
    return <UserMessageBubble message={message} />;
  }
  return <AssistantTurn message={message} taskLookup={taskLookup} stopped={stopped} />;
}

function AssistantTurn({
  message,
  taskLookup,
  stopped,
}: {
  message: GoatChatUiMessage;
  taskLookup: ChatTaskLookup;
  stopped: boolean;
}) {
  const error = message.metadata?.error;
  const items = getOrderedAssistantItems(
    message,
    taskLookup,
    stopped || message.metadata?.aborted === true,
  );

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => {
        if (item.type === "text") {
          return (
            <AssistantTextBubble key={item.key} text={item.text} {...(error ? { error } : {})} />
          );
        }
        if (item.type === "reasoning") return <ReasoningItem key={item.key} text={item.text} />;
        if (item.type === "task") return <TaskCard key={item.key} task={item.task} />;
        return <ToolCallItem key={item.key} tool={item.tool} />;
      })}
    </div>
  );
}
