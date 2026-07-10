import type { CodexAppServerNormalizedEvent } from "./codex-app-server-events";

// Shared projection of normalized Codex app-server events into AI SDK UIMessage parts.
// Both the Goat local-codex bridge route and the cloud codex chat runner fold events
// through this reducer so every engine persists the same normalized assistant-turn
// shape (reasoning parts, codex_command tool parts, text parts) in
// chat_messages.debug_trace.uiMessageParts.

export const CODEX_COMMAND_TOOL_NAME = "codex_command";
export const CODEX_COMMAND_TOOL_PART_TYPE = `tool-${CODEX_COMMAND_TOOL_NAME}` as const;
export const CODEX_COMMAND_OUTPUT_PREVIEW_LIMIT = 4_000;

export type CodexCommandToolInput = { command: string };
export type CodexCommandToolOutput = {
  status: "completed" | "failed" | "interrupted";
  exitCode: number | null;
  outputPreview?: string;
};

export type CodexUiTextPart = { type: "text"; text: string };
export type CodexUiReasoningPart = { type: "reasoning"; text: string; state: "done" };
export type CodexUiCommandPart = {
  type: typeof CODEX_COMMAND_TOOL_PART_TYPE;
  toolCallId: string;
  input: CodexCommandToolInput;
} & (
  | { state: "input-available" }
  | { state: "output-available"; output: CodexCommandToolOutput }
  | { state: "output-error"; errorText: string }
);
export type CodexUiMessagePart = CodexUiTextPart | CodexUiReasoningPart | CodexUiCommandPart;

export type CodexUiMessageProjection = {
  parts: CodexUiMessagePart[];
  content: string;
  error: string | null;
  changed: boolean;
};

type ApplyCodexEventOptions = {
  // Truncated tail of the command's aggregated output, folded into the tool part on
  // command.completed / command.failed. Callers that buffer command.output deltas
  // (see createCodexCommandOutputAccumulator) pass it here; omitting it is fine.
  commandOutputPreview?: string | null;
};

export function applyCodexEventToUiMessageParts(
  parts: readonly CodexUiMessagePart[],
  event: CodexAppServerNormalizedEvent,
  options: ApplyCodexEventOptions = {},
): CodexUiMessageProjection {
  switch (event.type) {
    case "assistant.completed": {
      const text = readString(event.payload.content);
      if (!text) return unchanged(parts);
      return changed([...parts, { type: "text", text }]);
    }
    case "reasoning.completed": {
      const text = readString(event.payload.text);
      if (!text?.trim()) return unchanged(parts);
      return changed([...parts, { type: "reasoning", text, state: "done" }]);
    }
    case "command.started": {
      const toolCallId = commandToolCallId(event, parts);
      if (parts.some((part) => isCommandPart(part) && part.toolCallId === toolCallId)) {
        return unchanged(parts);
      }
      return changed([
        ...parts,
        {
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId,
          state: "input-available",
          input: { command: commandFromPayload(event) },
        },
      ]);
    }
    case "command.completed": {
      const output: CodexCommandToolOutput = {
        status: commandOutputStatus(event),
        exitCode: commandExitCode(event),
        ...(options.commandOutputPreview
          ? { outputPreview: truncateOutputPreview(options.commandOutputPreview) }
          : {}),
      };
      return changed(
        replaceCommandPart(parts, event, (existing) => ({
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId: existing.toolCallId,
          state: "output-available",
          input: existing.input,
          output,
        })),
      );
    }
    case "command.failed": {
      const errorText = readString(event.payload.error) ?? "Codex command failed.";
      return changed(
        replaceCommandPart(parts, event, (existing) => ({
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId: existing.toolCallId,
          state: "output-error",
          input: existing.input,
          errorText,
        })),
      );
    }
    case "error": {
      const message = readString(event.payload.message) ?? "Codex app-server error.";
      return { ...unchanged(parts), error: message, changed: true };
    }
    default:
      return unchanged(parts);
  }
}

// Marks dangling in-flight command parts terminal when a turn ends abnormally, so a
// reloaded chat never shows an eternal spinner for a dead turn.
export function finalizeCodexUiMessageParts(
  parts: readonly CodexUiMessagePart[],
  outcome: "interrupted" | "failed",
  error?: string | null,
): CodexUiMessageProjection {
  let didChange = false;
  const next = parts.map((part): CodexUiMessagePart => {
    if (!isCommandPart(part) || part.state !== "input-available") return part;
    didChange = true;
    if (outcome === "interrupted") {
      return {
        type: CODEX_COMMAND_TOOL_PART_TYPE,
        toolCallId: part.toolCallId,
        state: "output-available",
        input: part.input,
        output: { status: "interrupted", exitCode: null },
      };
    }
    return {
      type: CODEX_COMMAND_TOOL_PART_TYPE,
      toolCallId: part.toolCallId,
      state: "output-error",
      input: part.input,
      errorText: error?.trim() || "Codex turn failed.",
    };
  });
  return didChange ? changed(next) : unchanged(parts);
}

export function codexUiMessagePartsContent(parts: readonly CodexUiMessagePart[]): string {
  return parts
    .filter((part): part is CodexUiTextPart => part.type === "text")
    .map((part) => part.text)
    .filter((text) => text.trim())
    .join("\n\n");
}

export function parseCodexUiMessageParts(value: unknown): CodexUiMessagePart[] {
  if (!Array.isArray(value)) return [];
  const parts: CodexUiMessagePart[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const part = raw as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      parts.push({ type: "reasoning", text: part.text, state: "done" });
      continue;
    }
    if (part.type === CODEX_COMMAND_TOOL_PART_TYPE && typeof part.toolCallId === "string") {
      const command = readString((part.input as Record<string, unknown> | undefined)?.command);
      const input: CodexCommandToolInput = { command: command ?? "command" };
      if (part.state === "input-available") {
        parts.push({
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId: part.toolCallId,
          state: "input-available",
          input,
        });
      } else if (part.state === "output-available") {
        const output = parseCommandOutput(part.output);
        parts.push({
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId: part.toolCallId,
          state: "output-available",
          input,
          output,
        });
      } else if (part.state === "output-error") {
        const errorText = readString(part.errorText) ?? "Codex command failed.";
        parts.push({
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId: part.toolCallId,
          state: "output-error",
          input,
          errorText,
        });
      }
    }
  }
  return parts;
}

// Buffers command.output deltas per command item so a truncated tail can be attached
// to the completed tool part. Keeps only the newest bytes per item.
export function createCodexCommandOutputAccumulator(
  limit: number = CODEX_COMMAND_OUTPUT_PREVIEW_LIMIT,
) {
  const buffers = new Map<string, string>();
  return {
    push(event: CodexAppServerNormalizedEvent) {
      if (event.type !== "command.output") return;
      const itemId = readString(event.payload.itemId);
      const delta = typeof event.payload.delta === "string" ? event.payload.delta : "";
      if (!itemId || !delta) return;
      const next = (buffers.get(itemId) ?? "") + delta;
      buffers.set(itemId, next.length > limit ? next.slice(next.length - limit) : next);
    },
    take(itemId: string | null | undefined): string | null {
      if (!itemId) return null;
      const buffered = buffers.get(itemId);
      buffers.delete(itemId);
      return buffered?.trim() ? buffered : null;
    },
  };
}

function replaceCommandPart(
  parts: readonly CodexUiMessagePart[],
  event: CodexAppServerNormalizedEvent,
  replace: (
    existing: Extract<CodexUiCommandPart, { state: "input-available" }>,
  ) => CodexUiCommandPart,
): CodexUiMessagePart[] {
  const itemId = readString(event.payload.itemId);
  let index = -1;
  if (itemId) {
    index = parts.findIndex((part) => isCommandPart(part) && part.toolCallId === itemId);
  }
  if (index < 0) {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (part && isCommandPart(part) && part.state === "input-available") {
        index = i;
        break;
      }
    }
  }
  if (index < 0) {
    // No started part to finalize (started event lost); synthesize the terminal part.
    const synthesized = replace({
      type: CODEX_COMMAND_TOOL_PART_TYPE,
      toolCallId: itemId ?? `codex-cmd-${parts.length}`,
      state: "input-available",
      input: { command: commandFromPayload(event) },
    });
    return [...parts, synthesized];
  }
  const existing = parts[index] as CodexUiCommandPart;
  const next = [...parts];
  next[index] = replace({
    type: CODEX_COMMAND_TOOL_PART_TYPE,
    toolCallId: existing.toolCallId,
    state: "input-available",
    input: existing.input,
  });
  return next;
}

function commandToolCallId(
  event: CodexAppServerNormalizedEvent,
  parts: readonly CodexUiMessagePart[],
) {
  return readString(event.payload.itemId) ?? `codex-cmd-${parts.length}`;
}

function commandFromPayload(event: CodexAppServerNormalizedEvent) {
  return readString(event.payload.command) ?? "command";
}

function commandOutputStatus(
  event: CodexAppServerNormalizedEvent,
): CodexCommandToolOutput["status"] {
  const output = event.payload.output;
  const status =
    output && typeof output === "object" && !Array.isArray(output)
      ? readString((output as Record<string, unknown>).status)
      : null;
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return "completed";
}

function commandExitCode(event: CodexAppServerNormalizedEvent): number | null {
  const output = event.payload.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const exitCode = (output as Record<string, unknown>).exitCode;
  return typeof exitCode === "number" ? exitCode : null;
}

function parseCommandOutput(value: unknown): CodexCommandToolOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "completed", exitCode: null };
  }
  const record = value as Record<string, unknown>;
  const status = readString(record.status);
  return {
    status: status === "failed" || status === "interrupted" ? status : "completed",
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    ...(typeof record.outputPreview === "string" && record.outputPreview
      ? { outputPreview: record.outputPreview }
      : {}),
  };
}

function truncateOutputPreview(preview: string) {
  return preview.length > CODEX_COMMAND_OUTPUT_PREVIEW_LIMIT
    ? preview.slice(preview.length - CODEX_COMMAND_OUTPUT_PREVIEW_LIMIT)
    : preview;
}

function isCommandPart(part: CodexUiMessagePart): part is CodexUiCommandPart {
  return part.type === CODEX_COMMAND_TOOL_PART_TYPE;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function unchanged(parts: readonly CodexUiMessagePart[]): CodexUiMessageProjection {
  return {
    parts: [...parts],
    content: codexUiMessagePartsContent(parts),
    error: null,
    changed: false,
  };
}

function changed(parts: CodexUiMessagePart[]): CodexUiMessageProjection {
  return { parts, content: codexUiMessagePartsContent(parts), error: null, changed: true };
}
