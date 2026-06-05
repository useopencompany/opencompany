import type { TextStreamPart, ToolSet } from "ai";
import { RunAbortError } from "./run-control";

const INVALID_TOOL_INPUT_PREFIX = "Invalid input for tool ";
// AI SDK `NoSuchToolError.message`. When the model calls a tool whose schema was not registered
// this turn — most often a deferred capability tool invoked by its real name instead of through the
// `use_tool` dispatcher — the SDK surfaces a `tool-error` stream part carrying this message.
const UNKNOWN_TOOL_PREFIX = "Model tried to call unavailable tool ";

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
type RecoverableToolErrorKind = "invalid_tool_input" | "unknown_tool";

function classifyRecoverableToolStreamError(
  part: TextStreamPart<ToolSet>,
): RecoverableToolErrorKind | null {
  if (part.type !== "tool-error") return null;
  const message = readStreamErrorMessage(part.error);
  if (message.startsWith(INVALID_TOOL_INPUT_PREFIX)) return "invalid_tool_input";
  if (message.startsWith(UNKNOWN_TOOL_PREFIX)) return "unknown_tool";
  return null;
}

// Tool-error stream parts the model can recover from on its own: a bad-arguments call
// (InvalidToolInputError) or a call to a tool whose schema was not registered this turn
// (NoSuchToolError). Both must surface as a tool result the model can read and retry from —
// never as a fatal `session.error` that kills the turn. Anything else (gateway/provider errors)
// stays fatal via `throwIfStreamErrorPart`.
export function isRecoverableToolStreamError(part: TextStreamPart<ToolSet>): part is ToolErrorPart {
  return classifyRecoverableToolStreamError(part) !== null;
}

export function buildRecoverableToolStreamOutput(part: ToolErrorPart) {
  const kind = classifyRecoverableToolStreamError(part);
  if (kind === "unknown_tool") {
    return {
      ok: false,
      error: {
        // The model named a tool that is not directly callable — almost always a deferred
        // capability tool it should reach through the dispatcher. Point it back at the discovery
        // protocol instead of crashing the turn.
        message: `${part.toolName} is not a directly callable tool. Tools beyond the core file/shell set are not preloaded — call find_tools to list available tools, then run this one with use_tool({ tool: "${part.toolName}", arguments }) using arguments that match its schema.`,
        code: "unknown_tool",
        recoverable: true,
      },
    };
  }
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
