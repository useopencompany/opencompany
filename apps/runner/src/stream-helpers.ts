import type { ModelMessage, SystemModelMessage, TextStreamPart, ToolSet } from "ai";
import { RunAbortError } from "./run-control";

const ANTHROPIC_ONE_HOUR_CACHE_CONTROL = {
  type: "ephemeral",
  ttl: "1h",
} as const;

export function throwIfStreamErrorPart(part: TextStreamPart<ToolSet>) {
  if (part.type === "abort") {
    throw new RunAbortError(part.reason || "Run aborted.");
  }

  if (part.type === "error") {
    throw toStreamError(part.error, "Model stream failed.");
  }

  if (part.type === "tool-error") {
    throw toStreamError(part.error, `Tool ${part.toolName} failed.`);
  }
}

export function readReasoningTextDelta(part: TextStreamPart<ToolSet> | Record<string, unknown>) {
  if (part.type === "reasoning" || part.type === "reasoning-delta") {
    if (typeof part.text === "string") return part.text;
    if ("delta" in part && typeof part.delta === "string") return part.delta;
    return "";
  }

  if (part.type === "raw") return readRawReasoningContent(part.rawValue);
  return "";
}

export function normalizeReasoningSummary(summary: string) {
  const normalized = summary
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized.length > 0 ? normalized : "";
}

export function buildCacheableSystemPrompt(
  systemPrompt: string,
  modelName: string,
): string | SystemModelMessage {
  if (!modelName.startsWith("anthropic/")) return systemPrompt;

  return {
    role: "system",
    content: systemPrompt,
    providerOptions: {
      anthropic: { cacheControl: ANTHROPIC_ONE_HOUR_CACHE_CONTROL },
    },
  };
}

export function addAnthropicCacheControlToLastMessage(
  messages: ModelMessage[],
  modelName: string,
): ModelMessage[] {
  if (!modelName.startsWith("anthropic/") || messages.length === 0) return messages;

  return messages.map((message, index) => {
    if (index !== messages.length - 1) return message;

    return {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        anthropic: {
          ...message.providerOptions?.anthropic,
          cacheControl: ANTHROPIC_ONE_HOUR_CACHE_CONTROL,
        },
      },
    };
  });
}

function toStreamError(error: unknown, fallback: string) {
  if (error instanceof Error) return error;
  if (typeof error === "string" && error.trim()) return new Error(error);
  if (error === null || error === undefined) return new Error(fallback);

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return new Error(serialized);
  } catch {
    // Fall through to the fallback message.
  }

  return new Error(fallback);
}

function readRawReasoningContent(value: unknown): string {
  if (!isRecord(value)) return "";
  const choices = value.choices;
  if (!Array.isArray(choices)) return "";
  return choices
    .map((choice) => {
      if (!isRecord(choice)) return "";
      const delta = choice.delta;
      if (!isRecord(delta)) return "";
      return typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    })
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
