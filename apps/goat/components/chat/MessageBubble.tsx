"use client";

import type { ReactNode } from "react";
import type { GoatChatUiAttachment, GoatChatUiMessage } from "@/lib/chat-ui";
import { AssistantTextBubble } from "./AssistantTextBubble";
import {
  type AssistantRenderItem,
  type ChatTaskLookup,
  getOrderedAssistantItems,
} from "./assistant-items";
import { ReasoningItem } from "./ReasoningItem";
import { TaskCard } from "./TaskCard";
import { TurnDuration } from "./ThinkingIndicator";
import {
  type ActionApprovalRequest,
  type CodexToolAction,
  SubagentRow,
  ToolCallItem,
} from "./ToolCallItem";
import { UserMessageBubble } from "./UserMessageBubble";

export function MessageBubble({
  message,
  taskLookup,
  stopped = false,
  durationMs,
  onCodexAction,
  allowCodexPlanActions = false,
  onActionApproval,
  allowActionApproval = false,
  readOnly = false,
  attachmentSrc,
  isStreaming = false,
}: {
  message: GoatChatUiMessage;
  taskLookup: ChatTaskLookup;
  stopped?: boolean;
  durationMs?: number | null | undefined;
  onCodexAction?: ((action: CodexToolAction) => Promise<void>) | undefined;
  allowCodexPlanActions?: boolean;
  onActionApproval?: ((request: ActionApprovalRequest) => Promise<void>) | undefined;
  allowActionApproval?: boolean;
  readOnly?: boolean;
  attachmentSrc?: (messageId: string, attachment: GoatChatUiAttachment) => string | undefined;
  isStreaming?: boolean;
}) {
  if (message.role === "user") {
    return <UserMessageBubble message={message} {...(attachmentSrc ? { attachmentSrc } : {})} />;
  }
  return (
    <AssistantTurn
      message={message}
      taskLookup={taskLookup}
      stopped={stopped}
      durationMs={durationMs}
      onCodexAction={onCodexAction}
      allowCodexPlanActions={allowCodexPlanActions}
      onActionApproval={onActionApproval}
      allowActionApproval={allowActionApproval}
      readOnly={readOnly}
      isStreaming={isStreaming}
    />
  );
}

function AssistantTurn({
  message,
  taskLookup,
  stopped,
  durationMs,
  onCodexAction,
  allowCodexPlanActions,
  onActionApproval,
  allowActionApproval,
  readOnly,
  isStreaming,
}: {
  message: GoatChatUiMessage;
  taskLookup: ChatTaskLookup;
  stopped: boolean;
  durationMs?: number | null | undefined;
  onCodexAction?: ((action: CodexToolAction) => Promise<void>) | undefined;
  allowCodexPlanActions: boolean;
  onActionApproval?: ((request: ActionApprovalRequest) => Promise<void>) | undefined;
  allowActionApproval: boolean;
  readOnly: boolean;
  isStreaming: boolean;
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
  const lastItem = items.at(-1);
  const animatedTextItemKey = isStreaming && lastItem?.type === "text" ? lastItem.key : null;

  // `nested` is set when rendering a subagent's own trace: its steps are historical, so they render
  // as plain read-only rows (no plan-implement / approval affordances) and no turn-level error.
  const renderItem = (item: AssistantRenderItem, nested: boolean): ReactNode => {
    if (item.type === "text") {
      return (
        <AssistantTextBubble
          key={item.key}
          text={item.text}
          citations={item.citations}
          isAnimating={!nested && item.key === animatedTextItemKey}
          {...(!nested && error ? { error } : {})}
        />
      );
    }
    if (item.type === "reasoning") return <ReasoningItem key={item.key} text={item.text} />;
    if (item.type === "task") {
      return <TaskCard key={item.key} task={item.task} readOnly={readOnly} />;
    }
    if (item.type === "subagent") {
      return (
        <SubagentRow
          key={item.key}
          tool={item.subagent.tool}
          childCount={item.subagent.children.length}
        >
          {item.subagent.children.map((child) => renderItem(child, true))}
        </SubagentRow>
      );
    }
    return (
      <ToolCallItem
        key={item.key}
        tool={item.tool}
        onCodexAction={onCodexAction}
        allowCodexPlanActions={allowCodexPlanActions}
        onActionApproval={onActionApproval}
        allowActionApproval={allowActionApproval}
        readOnly={readOnly || nested}
      />
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => renderItem(item, false))}
      {showStandaloneError && error ? <AssistantTextBubble text={error} error={error} /> : null}
      {typeof durationMs === "number" ? <TurnDuration durationMs={durationMs} /> : null}
    </div>
  );
}
