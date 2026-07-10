import type { CodexCommandToolInput, CodexCommandToolOutput } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type {
  GoatChatEngine,
  GoatChatMessage,
  GoatHarnessEngine,
  GoatTaskStatus,
} from "@opencompany/db/goat-schema";
import type { UIMessage } from "ai";

export {
  CODEX_APPROVAL_TOOL_NAME,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_COMMAND_TOOL_PART_TYPE,
  CODEX_GOAL_TOOL_NAME,
  CODEX_PLAN_TOOL_NAME,
  CODEX_QUESTION_TOOL_NAME,
  type CodexCommandToolInput,
  type CodexCommandToolOutput,
} from "@opencompany/agent-runtime";

export const START_TASK_TOOL_NAME = "start_task";
export const START_TASK_TOOL_PART_TYPE = `tool-${START_TASK_TOOL_NAME}` as const;
export const SCHEDULE_TASK_TOOL_NAME = "schedule_task";
export const SCHEDULE_TASK_TOOL_PART_TYPE = `tool-${SCHEDULE_TASK_TOOL_NAME}` as const;
export const EDIT_TASK_SCHEDULE_TOOL_NAME = "edit_task_schedule";
export const EDIT_TASK_SCHEDULE_TOOL_PART_TYPE = `tool-${EDIT_TASK_SCHEDULE_TOOL_NAME}` as const;
export const DELETE_TASK_SCHEDULE_TOOL_NAME = "delete_task_schedule";
export const DELETE_TASK_SCHEDULE_TOOL_PART_TYPE =
  `tool-${DELETE_TASK_SCHEDULE_TOOL_NAME}` as const;
export const GOAT_BRAIN_TOOL_NAME = "goat_brain";
export const GOAT_BRAIN_TOOL_PART_TYPE = `tool-${GOAT_BRAIN_TOOL_NAME}` as const;
export const SAVE_TO_BRAIN_TOOL_NAME = "save_to_brain";
export const SAVE_TO_BRAIN_TOOL_PART_TYPE = `tool-${SAVE_TO_BRAIN_TOOL_NAME}` as const;
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_SEARCH_TOOL_PART_TYPE = `tool-${WEB_SEARCH_TOOL_NAME}` as const;

export type GoatTaskCardMetadata = {
  id: string;
  displayId?: string | null;
  title?: string | null;
  status?: GoatTaskStatus | null;
};

export type GoatChatMention = {
  kind: "engine";
  id: "codex";
};

export type GoatChatMessageMetadata = {
  sessionId?: string;
  mentions?: GoatChatMention[];
  taskId?: string;
  task?: GoatTaskCardMetadata | null;
  error?: string;
  aborted?: boolean;
};

export type StartTaskToolInput = {
  prompt: string;
  name: string;
  engine?: GoatHarnessEngine;
  reason?: string;
};

export type StartTaskToolOutput = {
  taskId: string;
  taskDisplayId: string;
  taskName: string;
  status: "queued" | "already_started";
  prompt: string;
};

export type ScheduleTaskToolInput = {
  prompt: string;
  name: string;
  cron: string;
  timezone?: string;
  sourceDescription?: string;
  reason?: string;
};

export type ScheduleTaskToolOutput = {
  scheduleId: string;
  scheduleName: string;
  cron: string;
  timezone: string;
  nextRunAt: string;
  prompt: string;
  status: "scheduled";
};

export type EditTaskScheduleToolInput = {
  scheduleId?: string;
  scheduleName?: string;
  name?: string;
  prompt?: string;
  cron?: string;
  timezone?: string;
  sourceDescription?: string;
  reason?: string;
};

export type EditTaskScheduleToolOutput =
  | {
      ok: true;
      scheduleId: string;
      scheduleName: string;
      cron: string;
      timezone: string;
      nextRunAt: string;
      status: "updated";
    }
  | {
      ok: false;
      error: string;
      status: "not_found" | "ambiguous" | "invalid";
    };

export type DeleteTaskScheduleToolInput = {
  scheduleId?: string;
  scheduleName?: string;
  reason?: string;
};

export type DeleteTaskScheduleToolOutput =
  | {
      ok: true;
      scheduleId: string;
      scheduleName: string;
      status: "deleted";
    }
  | {
      ok: false;
      error: string;
      status: "not_found" | "ambiguous" | "invalid";
    };

export type GoatBrainCliCommand =
  | "help"
  | "create"
  | "list"
  | "get"
  | "timeline"
  | "query"
  | "append-evidence"
  | "rewrite"
  | "set"
  | "alias"
  | "timeline-add"
  | "append-timeline"
  | "link"
  | "merge"
  | "move"
  | "delete"
  | "folder"
  | "doctor";

export type GoatBrainToolFlagValue = string | number | boolean | string[];

export type GoatBrainToolInput = {
  command: GoatBrainCliCommand;
  flags?: Record<string, GoatBrainToolFlagValue>;
  stdin?: string;
};

export type GoatBrainToolOutput = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command?: string;
  argv?: string[];
  parsed?: unknown;
  error?: string;
  traceId?: string;
  tracePath?: string;
  durationMs?: number;
};

export type SaveToBrainToolInput = {
  content: string;
  title?: string;
  intent?: string;
};

export type SaveToBrainToolOutput =
  | {
      ok: true;
      draftId: string;
      path: string;
      title: string;
      status: "captured" | "already_captured";
    }
  | {
      ok: false;
      error: string;
    };

export type WebSearchToolInput = {
  query: string;
  recencyDays?: 7 | 30 | 90;
};

export type WebSearchToolResult = {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  highlights: string[];
};

export type WebSearchToolOutput =
  | {
      ok: true;
      query: string;
      searchedAt: string;
      results: WebSearchToolResult[];
      requestId?: string;
      costUsdMicros?: number;
    }
  | {
      ok: false;
      error: string;
    };

export type GoatChatTools = {
  start_task: {
    input: StartTaskToolInput;
    output: StartTaskToolOutput;
  };
  schedule_task: {
    input: ScheduleTaskToolInput;
    output: ScheduleTaskToolOutput;
  };
  edit_task_schedule: {
    input: EditTaskScheduleToolInput;
    output: EditTaskScheduleToolOutput;
  };
  delete_task_schedule: {
    input: DeleteTaskScheduleToolInput;
    output: DeleteTaskScheduleToolOutput;
  };
  goat_brain: {
    input: GoatBrainToolInput;
    output: GoatBrainToolOutput;
  };
  save_to_brain: {
    input: SaveToBrainToolInput;
    output: SaveToBrainToolOutput;
  };
  web_search: {
    input: WebSearchToolInput;
    output: WebSearchToolOutput;
  };
  codex_command: {
    input: CodexCommandToolInput;
    output: CodexCommandToolOutput;
  };
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
  messages: GoatChatUiMessage[];
};

export type GoatChatSummaryView = {
  id: string;
  title: string;
  model: AgentModelId;
  engine?: GoatChatEngine;
  preview: string;
  updatedAt: string;
};

export type GoatStoredChatMessage = Pick<
  GoatChatMessage,
  "id" | "sessionId" | "role" | "content" | "taskId" | "debugTrace" | "createdAt" | "updatedAt"
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
    "sessionId" | "taskId" | "taskDisplayId" | "taskName" | "taskStatus" | "debugTrace"
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

  if (!message.sessionId && !message.taskId && !task && !error && !aborted) return undefined;
  return {
    sessionId: message.sessionId,
    ...(message.taskId ? { taskId: message.taskId } : {}),
    ...(task ? { task } : {}),
    ...(error ? { error } : {}),
    ...(aborted ? { aborted } : {}),
  };
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

  const split = splitTaskContentAroundResults(message.content);
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

function splitTaskContentAroundResults(content: string) {
  const match = /\s*added to Results\b/i.exec(content);
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
