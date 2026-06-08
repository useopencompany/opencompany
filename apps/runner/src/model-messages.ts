import {
  type AssistantModelMessage,
  type ModelMessage,
  modelMessageSchema,
  type TextPart,
  type ToolCallPart,
  type ToolModelMessage,
  type ToolResultPart,
} from "ai";

export type PersistedModelMessage = Record<string, unknown>;
type AssistantContentPart = Extract<AssistantModelMessage["content"], unknown[]>[number];
type ReasoningReplayPart = Extract<AssistantContentPart, { type: "reasoning" }>;

export type ReplayAttachment = {
  kind: "image" | "pdf" | "text";
  mediaType: string;
  filename: string;
  base64: string; // hydrated by the loader (bytes downloaded from Blob)
};

export type StoredSessionMessageForModelReplay = {
  id?: string;
  role: string;
  content: string;
  modelMessage?: PersistedModelMessage | null;
  attachments?: ReplayAttachment[];
};

export type AssistantReplayPart = ReasoningReplayPart | TextPart | ToolCallPart;
type AssistantToolReplayMessage = Omit<AssistantModelMessage, "content"> & {
  role: "assistant";
  content: AssistantReplayPart[];
};

export function buildModelMessages(
  storedMessages: StoredSessionMessageForModelReplay[],
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (let index = 0; index < storedMessages.length; index += 1) {
    const message = storedMessages[index];
    if (!message) continue;
    const modelMessage = readStoredModelMessage(message);

    if (message.role === "user" && message.attachments && message.attachments.length > 0) {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content) parts.push({ type: "text", text: message.content });
      for (const att of message.attachments) {
        if (att.kind === "image") {
          // modelMessageSchema (ai@6) accepts a raw base64 string for `image` (DataContent).
          parts.push({ type: "image", image: att.base64, mediaType: att.mediaType });
        } else if (att.kind === "text") {
          // Text/code files are inlined as plain text (not base64) so every model can read
          // them with no file/vision capability — the bytes are UTF-8 decoded here.
          const text = Buffer.from(att.base64, "base64").toString("utf8");
          parts.push({ type: "text", text: `\n\nAttached file "${att.filename}":\n\n${text}` });
        } else {
          parts.push({
            type: "file",
            data: att.base64,
            mediaType: att.mediaType,
            filename: att.filename,
          });
        }
      }
      messages.push(validateModelMessage({ role: "user", content: parts }, message.id));
      continue;
    }

    if (isAssistantMessageWithToolCalls(modelMessage)) {
      const toolMessagesByCallId = new Map<string, ToolModelMessage>();
      let lookahead = index + 1;

      while (lookahead < storedMessages.length) {
        const storedToolMessage = storedMessages[lookahead];
        if (!storedToolMessage) break;
        const toolMessage = readStoredModelMessage(storedToolMessage);
        if (!isToolModelMessage(toolMessage)) break;

        const toolCallIds = readToolResultCallIds(toolMessage);
        if (toolCallIds.length === 0) break;
        for (const toolCallId of toolCallIds) {
          toolMessagesByCallId.set(toolCallId, toolMessage);
        }
        lookahead += 1;
      }

      const replayMessages = splitAssistantToolReplay(modelMessage, toolMessagesByCallId);
      if (replayMessages) {
        messages.push(...replayMessages);
        index = lookahead - 1;
        continue;
      }
    }

    if (isToolModelMessage(modelMessage)) continue;
    if (modelMessage) messages.push(modelMessage);
  }

  return messages;
}

export function buildAssistantModelMessage(input: {
  content: string;
  parts: AssistantReplayPart[];
}): AssistantModelMessage {
  const hasToolCall = input.parts.some((part) => part.type === "tool-call");
  const hasReasoning = input.parts.some((part) => part.type === "reasoning");
  return validateModelMessage({
    role: "assistant",
    content: hasToolCall || hasReasoning ? input.parts : input.content,
  }) as AssistantModelMessage;
}

export function appendAssistantTextPart(parts: AssistantReplayPart[], text: string) {
  const previous = parts.at(-1);
  if (previous?.type === "text") {
    previous.text += text;
    return;
  }

  parts.push({ type: "text", text });
}

export function appendAssistantReasoningPart(parts: AssistantReplayPart[], text: string) {
  const previous = parts.at(-1);
  if (previous?.type === "reasoning") {
    previous.text += text;
    return;
  }

  parts.push({ type: "reasoning", text });
}

export function buildToolModelMessage(input: {
  toolCallId: string;
  toolName: string;
  output: unknown;
}): ToolModelMessage {
  return validateModelMessage({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        output: toToolResultOutput(input.output),
      },
    ],
  }) as ToolModelMessage;
}

export function toPersistedModelMessage(message: ModelMessage): PersistedModelMessage {
  return validateModelMessage(message) as unknown as PersistedModelMessage;
}

export function validateModelMessage(value: unknown, messageId = "unknown"): ModelMessage {
  const parsed = modelMessageSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Stored model message is invalid for ${messageId}.`);
  }
  return parsed.data;
}

export function serializeToolOutputForStorage(output: unknown) {
  try {
    const serialized = JSON.stringify(output);
    if (serialized !== undefined) return serialized;
  } catch {
    // Fall through to a text representation for non-JSON values.
  }
  return String(output);
}

function legacyModelMessage(message: StoredSessionMessageForModelReplay): ModelMessage | null {
  if (message.role === "user" || message.role === "assistant") {
    return validateModelMessage({ role: message.role, content: message.content }, message.id);
  }
  return null;
}

function readStoredModelMessage(message: StoredSessionMessageForModelReplay): ModelMessage | null {
  return message.modelMessage
    ? validateModelMessage(message.modelMessage, message.id)
    : legacyModelMessage(message);
}

function isAssistantMessageWithToolCalls(
  message: ModelMessage | null,
): message is AssistantToolReplayMessage {
  return (
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((part) => isToolCallPart(part))
  );
}

function splitAssistantToolReplay(
  message: AssistantToolReplayMessage,
  toolMessagesByCallId: Map<string, ToolModelMessage>,
): ModelMessage[] | null {
  // Drop tool-call parts with no matching tool-result. A turn that suspended at an "ask"
  // gate (or was aborted while paused) leaves the assistant message ending in a dangling
  // tool-call; replaying it verbatim would send the provider a tool_use with no following
  // tool_result and error the next turn. The normal case (every tool-call has a result)
  // is unaffected.
  const content = message.content.filter(
    (part) => !isToolCallPart(part) || toolMessagesByCallId.has(part.toolCallId),
  );
  if (!content.some(isToolCallPart)) {
    const text = content
      .filter(isTextPart)
      .map((part) => part.text)
      .join("");
    return text ? [validateModelMessage({ role: "assistant", content: text })] : [];
  }

  const messages: ModelMessage[] = [];
  let assistantParts: AssistantReplayPart[] = [];
  let pendingToolCallIds: string[] = [];

  const flushAssistantAndTools = () => {
    if (assistantParts.length > 0) {
      messages.push(buildAssistantReplayModelMessage(assistantParts));
    }
    if (pendingToolCallIds.length > 0) {
      messages.push(buildCombinedToolModelMessage(pendingToolCallIds, toolMessagesByCallId));
    }
    assistantParts = [];
    pendingToolCallIds = [];
  };

  for (const part of content) {
    if (isToolCallPart(part)) {
      assistantParts.push(part);
      pendingToolCallIds.push(part.toolCallId);
      continue;
    }

    if (pendingToolCallIds.length > 0) {
      flushAssistantAndTools();
    }

    if (isReasoningPart(part) || (isTextPart(part) && part.text)) assistantParts.push(part);
  }

  if (assistantParts.length > 0 || pendingToolCallIds.length > 0) {
    flushAssistantAndTools();
  }

  return messages;
}

function buildAssistantReplayModelMessage(parts: AssistantReplayPart[]): AssistantModelMessage {
  const hasToolCall = parts.some(isToolCallPart);
  const hasReasoning = parts.some(isReasoningPart);
  const text = parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");

  return validateModelMessage({
    role: "assistant",
    content: hasToolCall || hasReasoning ? parts : text,
  }) as AssistantModelMessage;
}

function buildCombinedToolModelMessage(
  toolCallIds: string[],
  toolMessagesByCallId: Map<string, ToolModelMessage>,
): ToolModelMessage {
  const content: ToolResultPart[] = [];
  for (const toolCallId of toolCallIds) {
    const toolMessage = toolMessagesByCallId.get(toolCallId);
    if (!toolMessage) continue;
    content.push(...toolMessage.content.filter(isToolResultPart));
  }

  return validateModelMessage({ role: "tool", content }) as ToolModelMessage;
}

function isToolModelMessage(message: ModelMessage | null): message is ToolModelMessage {
  return message?.role === "tool" && Array.isArray(message.content);
}

function readToolResultCallIds(message: ToolModelMessage) {
  return message.content.filter(isToolResultPart).map((part) => part.toolCallId);
}

function isTextPart(part: unknown): part is TextPart {
  return isRecord(part) && part.type === "text" && typeof part.text === "string";
}

function isReasoningPart(part: unknown): part is ReasoningReplayPart {
  return isRecord(part) && part.type === "reasoning" && typeof part.text === "string";
}

function isToolCallPart(part: unknown): part is ToolCallPart {
  return isRecord(part) && part.type === "tool-call" && typeof part.toolCallId === "string";
}

function isToolResultPart(part: ToolModelMessage["content"][number]): part is ToolResultPart {
  return part.type === "tool-result";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toToolResultOutput(output: unknown): ToolResultPart["output"] {
  const jsonValue = toJsonValue(output);
  if (jsonValue.ok) {
    return { type: "json", value: jsonValue.value } as ToolResultPart["output"];
  }

  return { type: "text", value: serializeToolOutputForStorage(output) };
}

function toJsonValue(output: unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    const serialized = JSON.stringify(output);
    if (serialized === undefined) return { ok: false };
    return { ok: true, value: JSON.parse(serialized) };
  } catch {
    return { ok: false };
  }
}
