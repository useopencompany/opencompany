"use client";

import type { PublishedChatArtifact } from "@opencompany/agent-runtime";
import { ChevronRight } from "lucide-react";
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
  compactTrace = false,
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
  compactTrace?: boolean;
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
      compactTrace={compactTrace}
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
  compactTrace,
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
  compactTrace: boolean;
  artifactHref?: (artifact: PublishedChatArtifact) => string;
}) {
  const [traceExpanded, setTraceExpanded] = useState(false);
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
  const compactedTrace = compactTrace ? compactAssistantTrace(items) : null;
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
      {compactedTrace ? (
        <>
          <div className="-ml-1 max-w-[92%] text-[11.5px] leading-5 text-ink-muted">
            <button
              type="button"
              aria-expanded={traceExpanded}
              onClick={() => setTraceExpanded((expanded) => !expanded)}
              className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-px text-left transition-colors hover:bg-surface-hover/65 hover:text-ink/75 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <ChevronRight
                size={11}
                strokeWidth={1.9}
                className={`shrink-0 text-ink-subtle transition-transform ${traceExpanded ? "rotate-90" : ""}`}
              />
              <span className="font-medium text-ink/65">
                {assistantTraceSummary(compactedTrace)}
              </span>
            </button>
            {traceExpanded ? (
              <div className="ml-2 mt-1 flex flex-col gap-2 border-l border-border pl-3">
                {compactedTrace.hiddenItems.map((item) => renderItem(item, false))}
              </div>
            ) : null}
          </div>
          {compactedTrace.visibleItems.map((item) => renderItem(item, false))}
        </>
      ) : (
        items.map((item) => renderItem(item, false))
      )}
      {error ? <TurnErrorNotice error={error} hasPartialOutput={items.length > 0} /> : null}
      {typeof durationMs === "number" ? <TurnDuration durationMs={durationMs} /> : null}
    </div>
  );
}

type CompactedAssistantTrace = {
  hiddenItems: AssistantRenderItem[];
  visibleItems: AssistantRenderItem[];
  messageCount: number;
  toolCallCount: number;
};

function compactAssistantTrace(items: AssistantRenderItem[]): CompactedAssistantTrace | null {
  const finalMessageIndex = items.findLastIndex((item) => item.type === "text");
  if (finalMessageIndex <= 0) return null;

  const hiddenItems = items.slice(0, finalMessageIndex);
  // Artifact and task cards are user-facing outputs, not implementation trace. Keep the whole turn
  // expanded rather than moving or hiding those cards. The same applies to an unresolved tool.
  if (
    hiddenItems.some(
      (item) =>
        item.type === "artifact" ||
        item.type === "task" ||
        ((item.type === "tool" || item.type === "subagent") && hasUnresolvedTool(item)),
    )
  ) {
    return null;
  }

  const counts = countAssistantTraceItems(hiddenItems);
  if (counts.messageCount === 0 && counts.toolCallCount === 0) return null;
  return {
    hiddenItems,
    visibleItems: items.slice(finalMessageIndex),
    ...counts,
  };
}

function hasUnresolvedTool(
  item: Extract<AssistantRenderItem, { type: "tool" | "subagent" }>,
): boolean {
  if (item.type === "tool") return item.tool.status === "running" || item.tool.status === "waiting";
  if (item.subagent.tool.status === "running" || item.subagent.tool.status === "waiting")
    return true;
  return item.subagent.children.some(
    (child) => (child.type === "tool" || child.type === "subagent") && hasUnresolvedTool(child),
  );
}

function countAssistantTraceItems(items: readonly AssistantRenderItem[]) {
  let messageCount = 0;
  let toolCallCount = 0;
  for (const item of items) {
    if (item.type === "text" || item.type === "reasoning") messageCount += 1;
    if (item.type === "tool") toolCallCount += 1;
    if (item.type === "subagent") {
      toolCallCount += 1;
      const childCounts = countAssistantTraceItems(item.subagent.children);
      messageCount += childCounts.messageCount;
      toolCallCount += childCounts.toolCallCount;
    }
  }
  return { messageCount, toolCallCount };
}

function assistantTraceSummary({ messageCount, toolCallCount }: CompactedAssistantTrace) {
  const parts: string[] = [];
  if (toolCallCount > 0) {
    parts.push(`${toolCallCount} ${toolCallCount === 1 ? "tool call" : "tool calls"}`);
  }
  if (messageCount > 0) {
    parts.push(`${messageCount} ${messageCount === 1 ? "message" : "messages"}`);
  }
  return parts.join(", ");
}
