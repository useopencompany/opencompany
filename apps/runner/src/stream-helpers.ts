import type { SystemModelMessage, TextStreamPart, ToolSet } from "ai";
import { RunAbortError } from "./run-control";

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
  if (part.type !== "reasoning" && part.type !== "reasoning-delta") return "";
  if (typeof part.text === "string") return part.text;
  if ("delta" in part && typeof part.delta === "string") return part.delta;
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
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  };
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
