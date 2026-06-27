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

// Upper bound on how much provider detail we fold into the session's lastError. Generous enough
// to carry a real reason ("context length 312000 exceeds 262144") but short enough that a giant
// echoed request body can't bloat the row or the UI notice.
const PROVIDER_ERROR_DETAIL_MAX = 600;

// Turn whatever the model turn threw into the single human-readable string we persist as the
// session's lastError (and report to Sentry / the session.error event). AI SDK gateway/provider
// failures arrive as an APICallError whose `.message` is just the bare HTTP status text — e.g.
// "Bad Request" — while the actionable reason (context overflow, unsupported input, rate limit)
// sits unread in `.statusCode` + `.responseBody`/`.data`. Surfacing only "Bad Request" makes
// these undiagnosable in prod, so we pull the real reason out here.
export function describeRunnerError(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error === "string" && error.trim() ? error.trim() : "Unknown runner error";
  }
  return describeApiCallError(error) ?? (error.message.trim() || "Unknown runner error");
}

function describeApiCallError(error: Error): string | null {
  const record = error as unknown as Record<string, unknown>;
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : undefined;
  // Duck-type rather than `instanceof APICallError`: the gateway error can be re-wrapped before it
  // reaches us, and the SDK error type has moved packages across versions. A numeric statusCode or
  // a responseBody string is a reliable tell regardless of how it was constructed.
  const looksLikeApiError =
    error.name === "AI_APICallError" ||
    error.name === "APICallError" ||
    statusCode !== undefined ||
    typeof record.responseBody === "string";
  if (!looksLikeApiError) return null;

  const reason = extractProviderReason(record.responseBody, record.data);
  const base = error.message.trim() || "Provider request failed";
  const status = statusCode !== undefined ? ` (HTTP ${statusCode})` : "";
  const detail = reason && reason !== base ? `: ${reason}` : "";
  return `${base}${status}${detail}`;
}

function extractProviderReason(responseBody: unknown, data: unknown): string | null {
  const fromData = readErrorMessageField(data);
  if (fromData) return truncateDetail(fromData);
  if (typeof responseBody === "string" && responseBody.trim()) {
    const trimmed = responseBody.trim();
    try {
      const fromBody = readErrorMessageField(JSON.parse(trimmed));
      if (fromBody) return truncateDetail(fromBody);
    } catch {
      // responseBody isn't JSON — fall through to the raw (truncated) text.
    }
    return truncateDetail(trimmed);
  }
  return null;
}

// Best-effort pull of a message out of a provider error payload. Covers both the OpenAI-style
// `{ error: { message } }` envelope the Vercel AI Gateway forwards and a bare `{ error: "..." }`
// or top-level `{ message }`.
function readErrorMessageField(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const err = value.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (isRecord(err) && typeof err.message === "string" && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return null;
}

function truncateDetail(value: string): string {
  return value.length > PROVIDER_ERROR_DETAIL_MAX
    ? `${value.slice(0, PROVIDER_ERROR_DETAIL_MAX)}…`
    : value;
}
