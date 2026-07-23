"use client";

import type { GoatChatUiMessage } from "@/lib/chat-ui";
import { AssistantTextBubble } from "./AssistantTextBubble";
import { type ChatTaskLookup, getOrderedAssistantItems } from "./assistant-items";
import { ReasoningItem } from "./ReasoningItem";
import { TaskCard } from "./TaskCard";
import { TurnDuration } from "./ThinkingIndicator";
import { type CapabilityApprovalAction, type CodexToolAction, ToolCallItem } from "./ToolCallItem";
import { UserMessageBubble } from "./UserMessageBubble";

export function MessageBubble({
  message,
  taskLookup,
  stopped = false,
  durationMs,
  onCodexAction,
  onCapabilityApproval,
  allowCodexPlanActions = false,
}: {
  message: GoatChatUiMessage;
  taskLookup: ChatTaskLookup;
  stopped?: boolean;
  durationMs?: number | null | undefined;
  onCodexAction?: ((action: CodexToolAction) => Promise<void>) | undefined;
  onCapabilityApproval?: ((action: CapabilityApprovalAction) => Promise<string>) | undefined;
  allowCodexPlanActions?: boolean;
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
      onCodexAction={onCodexAction}
      onCapabilityApproval={onCapabilityApproval}
      allowCodexPlanActions={allowCodexPlanActions}
    />
  );
}

function AssistantTurn({
  message,
  taskLookup,
  stopped,
  durationMs,
  onCodexAction,
  onCapabilityApproval,
  allowCodexPlanActions,
}: {
  message: GoatChatUiMessage;
  taskLookup: ChatTaskLookup;
  stopped: boolean;
  durationMs?: number | null | undefined;
  onCodexAction?: ((action: CodexToolAction) => Promise<void>) | undefined;
  onCapabilityApproval?: ((action: CapabilityApprovalAction) => Promise<string>) | undefined;
  allowCodexPlanActions: boolean;
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
        return (
          <ToolCallItem
            key={item.key}
            tool={item.tool}
            onCodexAction={onCodexAction}
            onCapabilityApproval={onCapabilityApproval}
            allowCodexPlanActions={allowCodexPlanActions}
          />
        );
      })}
      {showStandaloneError && error ? <AssistantTextBubble text={error} error={error} /> : null}
      {typeof durationMs === "number" ? <TurnDuration durationMs={durationMs} /> : null}
    </div>
  );
}
