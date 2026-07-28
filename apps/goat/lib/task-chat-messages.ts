import type { GoatChatUiMessage } from "@/lib/chat-ui";
import type {
  GoatHarnessRunToolCall,
  GoatHarnessRunViewModel,
  GoatRunMessage,
} from "@/lib/task-harness-run";

// Reprojects a task run onto the exact message shape the main chat renders, so a
// task detail can reuse `MessageBubble` (user bubbles, assistant text, tool rows)
// instead of a bespoke transcript. Tool calls and assistant text are interleaved
// by timestamp into a single assistant turn — matching how the chat orders an
// assistant message's parts.
export function goatHarnessRunToChatMessages(run: GoatHarnessRunViewModel): GoatChatUiMessage[] {
  const messages: GoatChatUiMessage[] = [];

  const userContent = run.userMessage?.content || run.task.prompt;
  if (userContent.trim()) {
    messages.push({
      id: run.userMessage?.id ?? `${run.task.id}-user`,
      role: "user",
      parts: [{ type: "text", text: userContent }],
    } as GoatChatUiMessage);
  }

  const entries: { createdAt: string; part: Record<string, unknown> }[] = [];
  for (const toolCall of run.toolCalls) {
    entries.push({ createdAt: toolCall.createdAt, part: toolPartFromToolCall(toolCall) });
  }
  for (const message of run.assistantMessages) {
    if (!message.content.trim()) continue;
    entries.push({ createdAt: message.createdAt, part: { type: "text", text: message.content } });
  }
  entries.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  let parts = entries.map((entry) => entry.part);

  // Legacy runs keep no durable transcript rows; fall back to the stored result
  // so the assistant turn still renders its answer.
  if (parts.length === 0) {
    const fallback = run.task.result || lastCompletedAssistantContent(run.assistantMessages);
    if (fallback.trim()) parts = [{ type: "text", text: fallback }];
  }

  const error = run.task.error.trim();
  const assistantId = run.assistantMessages[0]?.id ?? `${run.task.id}-assistant`;
  if (parts.length > 0 || error) {
    messages.push({
      id: assistantId,
      role: "assistant",
      parts: parts.length > 0 ? parts : [{ type: "text", text: "" }],
      ...(error ? { metadata: { error } } : {}),
    } as unknown as GoatChatUiMessage);
  }

  return messages;
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

function lastCompletedAssistantContent(messages: readonly GoatRunMessage[]) {
  const message = messages
    .filter((item) => item.role === "assistant" && item.status === "completed" && item.content)
    .at(-1);
  return message?.content.trim() ?? "";
}
