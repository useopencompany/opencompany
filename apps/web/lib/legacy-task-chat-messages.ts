import type { GoatChatUiMessage } from "@/lib/chat-ui";
import type { GoatHarnessRunToolCall, GoatHarnessRunViewModel } from "@/lib/task-harness-run";

// Read-only compatibility projection for task rows created before tasks became
// native chat sessions. New tasks render their chat_messages directly.
export function legacyGoatHarnessRunToChatMessages(
  run: GoatHarnessRunViewModel,
): GoatChatUiMessage[] {
  const conversation = run.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (conversation.length === 0) return legacyTaskMessages(run);

  const lastAssistantId = conversation.findLast((message) => message.role === "assistant")?.id;
  const messages: GoatChatUiMessage[] = [];
  for (const [index, message] of conversation.entries()) {
    if (message.role === "user") {
      if (!message.content.trim()) continue;
      messages.push({
        id: message.id,
        role: "user",
        parts: [{ type: "text", text: message.content }],
      } as GoatChatUiMessage);
      continue;
    }

    const previousUserMessage = conversation
      .slice(0, index)
      .findLast((candidate) => candidate.role === "user");
    const nextUserMessage = conversation
      .slice(index + 1)
      .find((candidate) => candidate.role === "user");
    const parts = run.toolCalls
      .filter((toolCall) =>
        belongsToAssistantTurn(
          toolCall.createdAt,
          previousUserMessage?.createdAt ?? message.createdAt,
          nextUserMessage?.createdAt,
        ),
      )
      .map(toolPartFromToolCall);
    if (message.content.trim()) {
      parts.push({ type: "text", text: message.content });
    }

    const error = message.id === lastAssistantId ? run.task.error.trim() : "";
    if (parts.length === 0 && !error) continue;
    messages.push({
      id: message.id,
      role: "assistant",
      parts: parts.length > 0 ? parts : [{ type: "text", text: "" }],
      ...(error ? { metadata: { error } } : {}),
    } as unknown as GoatChatUiMessage);
  }

  const fallbackAssistantContent = run.task.result.trim();
  if (
    !lastAssistantId &&
    (run.toolCalls.length > 0 || fallbackAssistantContent || run.task.error.trim())
  ) {
    const error = run.task.error.trim();
    const parts = run.toolCalls.map(toolPartFromToolCall);
    if (fallbackAssistantContent) {
      parts.push({ type: "text", text: fallbackAssistantContent });
    }
    messages.push({
      id: `${run.task.id}-assistant`,
      role: "assistant",
      parts: parts.length > 0 ? parts : [{ type: "text", text: "" }],
      ...(error ? { metadata: { error } } : {}),
    } as unknown as GoatChatUiMessage);
  }

  return messages;
}

function legacyTaskMessages(run: GoatHarnessRunViewModel): GoatChatUiMessage[] {
  const messages: GoatChatUiMessage[] = [];
  const userContent = run.task.prompt.trim();
  if (userContent) {
    messages.push({
      id: `${run.task.id}-user`,
      role: "user",
      parts: [{ type: "text", text: userContent }],
    } as GoatChatUiMessage);
  }

  const assistantContent = run.task.result.trim();
  const error = run.task.error.trim();
  if (assistantContent || error) {
    messages.push({
      id: `${run.task.id}-assistant`,
      role: "assistant",
      parts: [{ type: "text", text: assistantContent }],
      ...(error ? { metadata: { error } } : {}),
    } as unknown as GoatChatUiMessage);
  }
  return messages;
}

function belongsToAssistantTurn(
  toolCreatedAt: string,
  turnStartedAt: string,
  nextUserMessageCreatedAt?: string,
) {
  const toolTimestamp = timestamp(toolCreatedAt);
  return (
    toolTimestamp >= timestamp(turnStartedAt) &&
    (!nextUserMessageCreatedAt || toolTimestamp < timestamp(nextUserMessageCreatedAt))
  );
}

function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toolPartFromToolCall(toolCall: GoatHarnessRunToolCall): Record<string, unknown> {
  const state =
    toolCall.status === "completed"
      ? "output-available"
      : toolCall.status === "failed"
        ? "output-error"
        : "input-available";
  return {
    type: `tool-${toolCall.name}`,
    toolCallId: toolCall.id,
    state,
    input: parsePreview(toolCall.inputPreview),
    ...(state === "output-available" ? { output: parsePreview(toolCall.outputPreview) } : {}),
    ...(state === "output-error"
      ? { errorText: toolCall.errorPreview || "Tool call failed." }
      : {}),
  };
}

function parsePreview(preview: string): unknown {
  if (!preview) return undefined;
  try {
    return JSON.parse(preview);
  } catch {
    return preview;
  }
}
