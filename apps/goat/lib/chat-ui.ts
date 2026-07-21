import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type {
  GoatChatAttachmentKind,
  GoatChatEngine,
  GoatChatMessage,
  GoatCodexChatSessionStatus,
  GoatTaskStatus,
} from "@opencompany/db/goat-schema";
import {
  type GoatChatTools,
  START_TASK_TOOL_PART_TYPE,
  type StartTaskToolInput,
  type StartTaskToolOutput,
} from "@opencompany/goat-agent/chat-tools";
import type { UIMessage } from "ai";
import { finiteDurationMs } from "@/lib/chat-timing";
import type { GoatCodexComposerSettingsView } from "@/lib/codex-chat-settings";

export {
  CODEX_APPROVAL_TOOL_NAME,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_COMMAND_TOOL_PART_TYPE,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_GOAL_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
  CODEX_PLAN_TOOL_NAME,
  CODEX_QUESTION_TOOL_NAME,
  CODEX_WEB_SEARCH_TOOL_NAME,
  type CodexCommandToolInput,
  type CodexCommandToolOutput,
} from "@opencompany/agent-runtime";

// Shim re-export: the tool-name constants and tool input/output types moved to
// @opencompany/goat-agent so apps/runner can use them too.
export * from "@opencompany/goat-agent/chat-tools";

export type GoatTaskCardMetadata = {
  id: string;
  displayId?: string | null;
  title?: string | null;
  status?: GoatTaskStatus | null;
};

export type GoatChatMention =
  | {
      kind: "engine";
      id: "codex";
    }
  | {
      kind: "skill";
      brainRef: string;
      id: string;
    };

// Attachment view riding on user-message metadata. The blob fields are only
// present client → server on submit (the server re-validates them); server →
// client rehydration strips them — the client fetches bytes through
// /api/chat-attachments/{messageId}/{attachmentId} instead.
export type GoatChatUiAttachment = {
  id: string;
  kind: GoatChatAttachmentKind;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  blobUrl?: string;
  blobPathname?: string;
  // Local object URL for the optimistic (not-yet-persisted) message render;
  // never persisted and ignored by the server.
  previewUrl?: string;
};

export type GoatChatMessageMetadata = {
  sessionId?: string;
  mentions?: GoatChatMention[];
  attachments?: GoatChatUiAttachment[];
  taskId?: string;
  task?: GoatTaskCardMetadata | null;
  timing?: {
    createdAt?: string;
    updatedAt?: string;
    durationMs?: number;
  };
  // Approximate context-window occupancy after this turn (input + output tokens of
  // the final model call), used to render the chat header's context meter.
  contextTokens?: number;
  error?: string;
  aborted?: boolean;
};

export type GoatChatUiMessage = UIMessage<
  GoatChatMessageMetadata,
  Record<string, never>,
  GoatChatTools
>;

export type GoatChatSessionView = {
  id: string;
  title: string;
  model: AgentModelId;
  engine?: GoatChatEngine;
  // Set when this session is a task's run; the composer steers via the task
  // messages endpoint instead of /api/chat.
  taskId?: string | null;
  codexComposerSettings?: GoatCodexComposerSettingsView | null;
  codexRuntime?: GoatCodexRuntimeView | null;
  messages: GoatChatUiMessage[];
};

export type GoatCodexRuntimeView = {
  status: GoatCodexChatSessionStatus;
  error: string | null;
  updatedAt: string;
};

export type GoatChatSummaryView = {
  id: string;
  title: string;
  model: AgentModelId;
  engine?: GoatChatEngine;
  codexComposerSettings?: GoatCodexComposerSettingsView | null;
  codexRuntime?: GoatCodexRuntimeView | null;
  preview: string;
  updatedAt: string;
  pinnedAt?: string | null;
  archived?: boolean;
};

export const GOAT_PINNED_CHAT_LIMIT = 20;

export type GoatStoredChatMessage = Pick<
  GoatChatMessage,
  | "id"
  | "sessionId"
  | "role"
  | "content"
  | "taskId"
  | "debugTrace"
  | "attachments"
  | "attachmentTexts"
  | "createdAt"
  | "updatedAt"
> & {
  taskDisplayId: string | null;
  taskName: string | null;
  taskPrompt: string | null;
  taskStatus: GoatTaskStatus | null;
};

export type GoatChatMessageOrderInput = {
  id: string;
  role: "user" | "assistant";
  createdAt: Date | string;
};

export function compareGoatChatMessageOrder(
  left: GoatChatMessageOrderInput,
  right: GoatChatMessageOrderInput,
) {
  const timeDiff = chatMessageCreatedAtMs(left.createdAt) - chatMessageCreatedAtMs(right.createdAt);
  if (timeDiff !== 0) return timeDiff;

  const roleDiff = chatMessageRoleOrder(left.role) - chatMessageRoleOrder(right.role);
  if (roleDiff !== 0) return roleDiff;

  return left.id.localeCompare(right.id);
}

export function nextGoatChatMessageCreatedAt(createdAt: Date) {
  return new Date(createdAt.getTime() + 1);
}

export function textFromGoatChatUiMessage(message: Pick<GoatChatUiMessage, "parts">) {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

export function replaceGoatChatUiMessageText(
  message: GoatChatUiMessage,
  text: string,
): GoatChatUiMessage {
  let replaced = false;
  const parts = message.parts.map((part) => {
    if (part.type !== "text") return part;
    if (replaced) return { ...part, text: "" };
    replaced = true;
    return { ...part, text };
  });
  return {
    ...message,
    parts: replaced ? parts : [{ type: "text", text }, ...parts],
  };
}

export function toGoatChatUiMessage(message: GoatStoredChatMessage): GoatChatUiMessage {
  const metadata = toGoatChatMessageMetadata(message);
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    ...(metadata ? { metadata } : {}),
    parts: toGoatChatUiMessageParts(message, metadata),
  };
}

export function toGoatChatMessageMetadata(
  message: Pick<
    GoatStoredChatMessage,
    | "sessionId"
    | "taskId"
    | "taskDisplayId"
    | "taskName"
    | "taskStatus"
    | "debugTrace"
    | "attachments"
    | "createdAt"
    | "updatedAt"
  >,
): GoatChatMessageMetadata | undefined {
  const task =
    message.taskId && message.taskName && message.taskDisplayId
      ? {
          id: message.taskId,
          displayId: message.taskDisplayId,
          title: message.taskName,
          status: message.taskStatus,
        }
      : null;
  const error = message.debugTrace?.error;
  const aborted = message.debugTrace?.aborted === true;
  const timing = toGoatChatMessageTiming(message);
  const attachments = toGoatChatUiAttachments(message.attachments);
  const contextTokens = contextTokensFromUsage(message.debugTrace?.usage);

  if (
    !message.sessionId &&
    !message.taskId &&
    !task &&
    !timing &&
    contextTokens === undefined &&
    !error &&
    !aborted &&
    !attachments
  ) {
    return undefined;
  }
  return {
    sessionId: message.sessionId,
    ...(attachments ? { attachments } : {}),
    ...(message.taskId ? { taskId: message.taskId } : {}),
    ...(task ? { task } : {}),
    ...(timing ? { timing } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(error ? { error } : {}),
    ...(aborted ? { aborted } : {}),
  };
}

// Strips the private blob fields: the client fetches bytes through the
// auth-scoped attachment route, never from the blob store directly.
function toGoatChatUiAttachments(
  attachments: GoatStoredChatMessage["attachments"],
): GoatChatUiAttachment[] | null {
  if (!attachments || attachments.length === 0) return null;
  return attachments.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    mediaType: attachment.mediaType,
    filename: attachment.filename,
    sizeBytes: attachment.sizeBytes,
  }));
}

function contextTokensFromUsage(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null | undefined,
): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) return usage.totalTokens;
  const sum = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return sum > 0 ? sum : undefined;
}

function toGoatChatMessageTiming(
  message: Pick<GoatStoredChatMessage, "createdAt" | "updatedAt" | "debugTrace">,
) {
  const createdAt = serializeChatMessageTimestamp(message.createdAt);
  const updatedAt = serializeChatMessageTimestamp(message.updatedAt);
  const durationMs = finiteDurationMs(message.debugTrace?.durationMs);
  if (!createdAt && !updatedAt && durationMs === null) return null;
  return {
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
  };
}

function serializeChatMessageTimestamp(value: Date | string) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toGoatChatUiMessageParts(
  message: GoatStoredChatMessage,
  metadata: GoatChatMessageMetadata | undefined,
): GoatChatUiMessage["parts"] {
  if (message.role !== "assistant") return textParts(message.content);

  const persistedParts = parseDebugTraceUiMessageParts(message.debugTrace?.uiMessageParts);
  if (persistedParts) return withStoredContentFallback(persistedParts, message.content);

  const legacyTaskParts = legacyTaskOrderedParts(message, metadata?.task ?? null);
  if (legacyTaskParts) return legacyTaskParts;

  return textParts(message.content);
}

function textParts(content: string): GoatChatUiMessage["parts"] {
  return content ? [{ type: "text", text: content }] : [];
}

function withStoredContentFallback(
  parts: GoatChatUiMessage["parts"],
  content: string,
): GoatChatUiMessage["parts"] {
  if (!content || parts.some((part) => part.type === "text" && part.text.trim())) return parts;
  return [...parts, { type: "text", text: content }];
}

function parseDebugTraceUiMessageParts(value: unknown): GoatChatUiMessage["parts"] | null {
  if (!Array.isArray(value)) return null;

  const parts: GoatChatUiMessage["parts"] = [];
  for (const part of value) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      parts.push({ type: "reasoning", text: part.text, state: "done" });
      continue;
    }
    if (isPersistedToolPart(part)) {
      parts.push(part as GoatChatUiMessage["parts"][number]);
    }
  }

  return parts.length > 0 ? parts : null;
}

function isPersistedToolPart(value: Record<string, unknown>) {
  return (
    typeof value.type === "string" &&
    (value.type === "dynamic-tool" || value.type.startsWith("tool-"))
  );
}

function chatMessageCreatedAtMs(value: Date | string) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function chatMessageRoleOrder(role: "user" | "assistant") {
  return role === "user" ? 0 : 1;
}

function legacyTaskOrderedParts(
  message: GoatStoredChatMessage,
  task: GoatTaskCardMetadata | null,
): GoatChatUiMessage["parts"] | null {
  const output = legacyStartTaskOutput(message, task);
  if (!output) return null;

  const part = {
    type: START_TASK_TOOL_PART_TYPE,
    toolCallId: `persisted-${output.taskId}`,
    state: "output-available",
    input: legacyStartTaskInput(message, output),
    output,
  } as GoatChatUiMessage["parts"][number];

  const split = splitTaskContentAroundTaskNotice(message.content);
  if (!split) return [...textParts(message.content), part];

  const parts: GoatChatUiMessage["parts"] = [];
  if (split.before) parts.push({ type: "text", text: split.before });
  parts.push(part);
  if (split.after) parts.push({ type: "text", text: split.after });
  return parts;
}

function legacyStartTaskOutput(
  message: GoatStoredChatMessage,
  task: GoatTaskCardMetadata | null,
): StartTaskToolOutput | null {
  const toolResults = message.debugTrace?.toolResults;
  if (Array.isArray(toolResults)) {
    for (const result of toolResults) {
      const output = isRecord(result) && isRecord(result.output) ? result.output : result;
      if (isStartTaskToolOutput(output)) return output;
    }
  }

  if (!task) return null;
  return {
    taskId: task.id,
    taskDisplayId: task.displayId ?? task.id,
    taskName: task.title ?? "Task",
    status: "queued",
    prompt: message.taskPrompt ?? "",
  };
}

function legacyStartTaskInput(
  message: GoatStoredChatMessage,
  output: StartTaskToolOutput,
): StartTaskToolInput {
  const toolCalls = message.debugTrace?.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!isRecord(call)) continue;
      const input = isRecord(call.input) ? call.input : isRecord(call.args) ? call.args : null;
      if (!input) continue;
      const prompt = typeof input.prompt === "string" ? input.prompt : output.prompt;
      const name = typeof input.name === "string" ? input.name : output.taskName;
      const reason = typeof input.reason === "string" ? input.reason : undefined;
      return {
        prompt,
        name,
        ...(reason ? { reason } : {}),
      };
    }
  }

  return {
    prompt: output.prompt || message.taskPrompt || "",
    name: output.taskName,
  };
}

function splitTaskContentAroundTaskNotice(content: string) {
  const match = /\s*added to (?:Tasks|Results)\b/i.exec(content);
  if (!match) return null;

  return {
    before: content.slice(0, match.index).trim(),
    after: content.slice(match.index).trim(),
  };
}

function isStartTaskToolOutput(value: unknown): value is StartTaskToolOutput {
  if (!isRecord(value)) return false;
  return (
    typeof value.taskId === "string" &&
    typeof value.taskDisplayId === "string" &&
    typeof value.taskName === "string" &&
    (value.status === "queued" || value.status === "already_started") &&
    typeof value.prompt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
