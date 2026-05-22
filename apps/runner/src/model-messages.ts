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

export type StoredSessionMessageForModelReplay = {
  id?: string;
  role: string;
  content: string;
  modelMessage?: PersistedModelMessage | null;
};

export type AssistantReplayPart = TextPart | ToolCallPart;

export function buildModelMessages(
  storedMessages: StoredSessionMessageForModelReplay[],
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const message of storedMessages) {
    const modelMessage = message.modelMessage
      ? validateModelMessage(message.modelMessage, message.id)
      : legacyModelMessage(message);

    if (modelMessage) messages.push(modelMessage);
  }

  return messages;
}

export function buildAssistantModelMessage(input: {
  content: string;
  parts: AssistantReplayPart[];
}): AssistantModelMessage {
  const hasToolCall = input.parts.some((part) => part.type === "tool-call");
  return validateModelMessage({
    role: "assistant",
    content: hasToolCall ? input.parts : input.content,
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
