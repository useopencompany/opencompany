import type {
  GoatTaskEventPayload,
  GoatTaskEventType,
  GoatTaskMessageRole,
  GoatTaskMessageStatus,
  GoatTaskStatus,
  GoatTaskToolName,
} from "@opencompany/db/goat-schema";

export const GOAT_TASK_CONTINUATION_MAX_CHARS = 8_000;

const RECENT_TRANSCRIPT_LIMIT = 16;
const RECENT_EVENT_LIMIT = 12;
const MESSAGE_CONTEXT_MAX_CHARS = 1_200;
const RESULT_CONTEXT_MAX_CHARS = 6_000;
const ERROR_CONTEXT_MAX_CHARS = 2_000;
const EVENT_CONTEXT_MAX_CHARS = 700;

export type GoatTaskContinuationTaskContext = {
  displayId: string;
  name: string;
  prompt: string;
  status: GoatTaskStatus;
  result: string | null;
  error: string | null;
};

export type GoatTaskContinuationMessageRow = {
  id: string;
  role: GoatTaskMessageRole;
  status: GoatTaskMessageStatus;
  content: string;
  modelMessage: unknown;
  toolName: GoatTaskToolName | null;
  toolCallId: string | null;
  responseToMessageId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
};

export type GoatTaskContinuationEventRow = {
  id: number;
  messageId: string | null;
  type: GoatTaskEventType;
  payload: GoatTaskEventPayload;
  createdAt: Date | string;
};

export function buildGoatTaskContinuationPrompt(input: {
  task: GoatTaskContinuationTaskContext;
  messages: GoatTaskContinuationMessageRow[];
  events: GoatTaskContinuationEventRow[];
  latestInstruction: string;
}) {
  const transcript = input.messages
    .slice(-RECENT_TRANSCRIPT_LIMIT)
    .map((message) => formatMessageForContext(message))
    .join("\n");
  const events = input.events
    .slice(-RECENT_EVENT_LIMIT)
    .map((event) => formatEventForContext(event))
    .join("\n");

  return [
    "Continue this Goat task from its prior state using the latest human instruction.",
    "Do not repeat completed work or duplicate side effects unless the latest instruction explicitly asks for that.",
    "Use the prior result, transcript, and events as context. Produce the next assistant answer for the latest instruction.",
    "",
    `<task id="${escapeXml(input.task.displayId)}" name="${escapeXml(input.task.name)}">`,
    `<original_prompt>${escapeXml(truncateText(input.task.prompt, RESULT_CONTEXT_MAX_CHARS))}</original_prompt>`,
    `<previous_status>${escapeXml(input.task.status)}</previous_status>`,
    input.task.result
      ? `<previous_result>${escapeXml(truncateText(input.task.result, RESULT_CONTEXT_MAX_CHARS))}</previous_result>`
      : "<previous_result />",
    input.task.error
      ? `<previous_error>${escapeXml(truncateText(input.task.error, ERROR_CONTEXT_MAX_CHARS))}</previous_error>`
      : "<previous_error />",
    transcript
      ? `<recent_transcript>\n${transcript}\n</recent_transcript>`
      : "<recent_transcript />",
    events ? `<recent_events>\n${events}\n</recent_events>` : "<recent_events />",
    `<latest_human_instruction>${escapeXml(input.latestInstruction)}</latest_human_instruction>`,
    "</task>",
  ].join("\n");
}

function formatMessageForContext(message: GoatTaskContinuationMessageRow) {
  const tool = message.toolName ? ` tool="${message.toolName}"` : "";
  const responseTo = message.responseToMessageId
    ? ` response_to="${message.responseToMessageId}"`
    : "";
  return [
    `<message id="${escapeXml(message.id)}" role="${message.role}" status="${message.status}"${tool}${responseTo}>`,
    escapeXml(truncateText(message.content, MESSAGE_CONTEXT_MAX_CHARS)),
    "</message>",
  ].join("");
}

function formatEventForContext(event: GoatTaskContinuationEventRow) {
  return [
    `<event type="${event.type}"${event.messageId ? ` message_id="${escapeXml(event.messageId)}"` : ""}>`,
    escapeXml(truncateText(JSON.stringify(event.payload), EVENT_CONTEXT_MAX_CHARS)),
    "</event>",
  ].join("");
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n[truncated ${value.length - maxChars} chars]`;
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
