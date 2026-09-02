"use client";

import type { PublishedChatArtifact } from "@opencompany/agent-runtime";
import { type ReactNode, useCallback, useState } from "react";
import type { ChatUiAttachment, ChatUiMessage } from "@/lib/chat-ui";
import { loadHeadlessChatMessagePresentation } from "@/lib/headless-chat-presentations";
import { ArtifactFileCard } from "./ArtifactFileCard";
import { AssistantTextBubble } from "./AssistantTextBubble";
import {
  type AssistantRenderItem,
  type ChatTaskLookup,
  getOrderedAssistantItems,
} from "./assistant-items";
import type { HistoricalPresentationDetailController } from "./HistoricalPresentationDetail";
import { ReasoningItem } from "./ReasoningItem";
import { TaskCard } from "./TaskCard";
import { TurnDuration } from "./ThinkingIndicator";
import {
  type ActionApprovalRequest,
  type CodexToolAction,
  SubagentRow,
  ToolCallItem,
} from "./ToolCallItem";
import { TurnErrorNotice } from "./TurnErrorNotice";
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
  message: ChatUiMessage;
  taskLookup: ChatTaskLookup;
  stopped?: boolean;
  durationMs?: number | null | undefined;
  onCodexAction?: ((action: CodexToolAction) => Promise<void>) | undefined;
  allowCodexPlanActions?: boolean;
  onActionApproval?: ((request: ActionApprovalRequest) => Promise<void>) | undefined;
  allowActionApproval?: boolean;
  readOnly?: boolean;
  isTaskSession?: boolean;
  attachmentSrc?: (messageId: string, attachment: ChatUiAttachment) => string | undefined;
  artifactHref?: (artifact: PublishedChatArtifact) => string;
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
  message: ChatUiMessage;
  taskLookup: ChatTaskLookup;
  stopped: boolean;
  durationMs?: number | null | undefined;
  onCodexAction?: ((action: CodexToolAction) => Promise<void>) | undefined;
  allowCodexPlanActions: boolean;
  onActionApproval?: ((request: ActionApprovalRequest) => Promise<void>) | undefined;
  allowActionApproval: boolean;
  readOnly: boolean;
  isTaskSession: boolean;
  artifactHref?: (artifact: PublishedChatArtifact) => string;
}) {
  const presentationKey =
    message.metadata?.presentation?.source === "summary"
      ? `${message.id}:${message.metadata.presentation.updatedAt}`
      : null;
  const [presentationState, setPresentationState] = useState<{
    key: string;
    state: "loading" | "loaded" | "error";
    message?: ChatUiMessage;
    error?: string;
  } | null>(null);
  const activePresentationState =
    presentationState?.key === presentationKey ? presentationState : null;
  const resolvedMessage = activePresentationState?.message ?? message;
  const loadPresentation = useCallback(async () => {
    if (!presentationKey) return;
    setPresentationState((current) =>
      current?.key === presentationKey &&
      (current.state === "loading" || current.state === "loaded")
        ? current
        : { key: presentationKey, state: "loading" },
    );
    try {
      const resolved = await loadHeadlessChatMessagePresentation(message);
      setPresentationState((current) =>
        current?.key === presentationKey
          ? { key: presentationKey, state: "loaded", message: resolved }
          : current,
      );
    } catch (cause) {
      setPresentationState((current) =>
        current?.key === presentationKey
          ? {
              key: presentationKey,
              state: "error",
              error: cause instanceof Error ? cause.message : "Could not load this trace.",
            }
          : current,
      );
    }
  }, [message, presentationKey]);
  const historicalDetail: HistoricalPresentationDetailController | undefined = presentationKey
    ? {
        state: activePresentationState?.state ?? "idle",
        error: activePresentationState?.error ?? null,
        load: loadPresentation,
      }
    : undefined;
  const error = resolvedMessage.metadata?.error;
  // In task sessions this metadata identifies the surrounding run; in regular chats it is also
  // the legacy fallback for a task launched by this turn. Explicit start-task parts still render.
  const items = getOrderedAssistantItems(resolvedMessage, taskLookup, {
    stopped: stopped || resolvedMessage.metadata?.aborted === true,
    includeMetadataTaskCard: !isTaskSession,
  });
  // `nested` is set when rendering a subagent's own trace: its steps are historical, so they render
  // as plain read-only rows (no plan-implement / approval affordances).
  const renderItem = (item: AssistantRenderItem, nested: boolean): ReactNode => {
    if (item.type === "text") {
      return <AssistantTextBubble key={item.key} text={item.text} citations={item.citations} />;
    }
    if (item.type === "reasoning") {
      return (
        <ReasoningItem
          key={item.key}
          text={item.text}
          {...(historicalDetail ? { detail: historicalDetail } : {})}
        />
      );
    }
    if (item.type === "artifact") {
      return (
        <ArtifactFileCard
          key={item.key}
          artifact={item.artifact}
          href={
            artifactHref?.(item.artifact) ??
            `/v1/chat-artifacts/${encodeURIComponent(item.artifact.artifactId)}/versions/${encodeURIComponent(item.artifact.artifactVersionId)}`
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
          {...(historicalDetail ? { detail: historicalDetail } : {})}
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
        {...(historicalDetail ? { detail: historicalDetail } : {})}
      />
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => renderItem(item, false))}
      {error ? <TurnErrorNotice error={error} hasPartialOutput={items.length > 0} /> : null}
      {typeof durationMs === "number" ? <TurnDuration durationMs={durationMs} /> : null}
    </div>
  );
}
