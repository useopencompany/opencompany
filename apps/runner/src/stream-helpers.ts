import type { TextStreamPart, ToolSet } from "ai";
import { RunAbortError } from "./run-control";

const INVALID_TOOL_INPUT_PREFIX = "Invalid input for tool ";

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

type ToolErrorPart = Extract<TextStreamPart<ToolSet>, { type: "tool-error" }>;

export function isRecoverableToolInputStreamError(
  part: TextStreamPart<ToolSet>,
): part is ToolErrorPart {
  if (part.type !== "tool-error") return false;
  const message = readStreamErrorMessage(part.error);
  return message.startsWith(INVALID_TOOL_INPUT_PREFIX);
}

export function buildRecoverableToolInputOutput(part: ToolErrorPart) {
  const message = readStreamErrorMessage(part.error);
  const detail = message.includes("JSON parsing failed")
    ? "The arguments were not complete valid JSON."
    : "The arguments did not match the tool schema.";
  return {
    ok: false,
    error: {
      message: `${part.toolName} could not run because its input was invalid. ${detail} Recreate the tool call with complete, valid JSON arguments.`,
      code: "invalid_tool_input",
      recoverable: true,
    },
  };
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

function readStreamErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
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
