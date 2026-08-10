"use client";

import type { GoatPublishedChatArtifact } from "@opencompany/agent-runtime";
import type { ReactNode } from "react";
import type { GoatChatUiAttachment, GoatChatUiMessage } from "@/lib/chat-ui";
import { ArtifactFileCard } from "./ArtifactFileCard";
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
  isTaskSession = false,
  attachmentSrc,
  artifactHref,
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
  isTaskSession?: boolean;
  attachmentSrc?: (messageId: string, attachment: GoatChatUiAttachment) => string | undefined;
  artifactHref?: (artifact: GoatPublishedChatArtifact) => string;
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
      isTaskSession={isTaskSession}
      {...(artifactHref ? { artifactHref } : {})}
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
  isTaskSession,
  artifactHref,
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
  isTaskSession: boolean;
  artifactHref?: (artifact: GoatPublishedChatArtifact) => string;
}) {
  const error = message.metadata?.error;
  // In task sessions this metadata identifies the surrounding run; in regular chats it is also
  // the legacy fallback for a task launched by this turn. Explicit start-task parts still render.
  const items = getOrderedAssistantItems(message, taskLookup, {
    stopped: stopped || message.metadata?.aborted === true,
    includeMetadataTaskCard: !isTaskSession,
  });
  // Failed turns often end without any text part (sandbox start failure, disconnected auth);
  // the error must still get a bubble or the turn renders as nothing.
  const showStandaloneError = Boolean(error) && !items.some((item) => item.type === "text");

  // `nested` is set when rendering a subagent's own trace: its steps are historical, so they render
  // as plain read-only rows (no plan-implement / approval affordances) and no turn-level error.
  const renderItem = (item: AssistantRenderItem, nested: boolean): ReactNode => {
    if (item.type === "text") {
      return (
        <AssistantTextBubble
          key={item.key}
          text={item.text}
          citations={item.citations}
          {...(!nested && error ? { error } : {})}
        />
      );
    }
    if (item.type === "reasoning") return <ReasoningItem key={item.key} text={item.text} />;
    if (item.type === "artifact") {
      return (
        <ArtifactFileCard
          key={item.key}
          artifact={item.artifact}
          href={
            artifactHref?.(item.artifact) ??
            `/api/chat-artifacts/${encodeURIComponent(item.artifact.artifactId)}/versions/${encodeURIComponent(item.artifact.artifactVersionId)}`
          }
          readOnly={readOnly || nested}
        />
      );
    }
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
