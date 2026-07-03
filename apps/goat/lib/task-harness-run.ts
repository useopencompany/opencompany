import type {
  GoatTaskEvent,
  GoatTaskEventType,
  GoatTaskMessage,
  GoatTaskMessageRole,
  GoatTaskMessageStatus,
  GoatTaskStage,
  GoatTaskStatus,
  GoatTaskToolName,
} from "@opencompany/db/goat-schema";

export type GoatTaskRunTaskInput =
  | {
      id: string;
      displayId: string;
      name: string;
      prompt: string;
      model: string;
      status: GoatTaskStatus;
      stage: GoatTaskStage;
      result: string | null;
      error: string | null;
      createdAt: Date | string;
      updatedAt: Date | string;
    }
  | {
      id: string;
      display_id: string;
      name: string;
      prompt: string;
      model: string;
      status: GoatTaskStatus;
      stage: GoatTaskStage;
      result: string | null;
      error: string | null;
      created_at: string;
      updated_at: string;
    };

export type GoatTaskRunMessageInput =
  | GoatTaskMessage
  | {
      id: string;
      task_id: string;
      user_workos_id: string;
      role: GoatTaskMessageRole;
      status: GoatTaskMessageStatus;
      content: string;
      model_message: unknown | null;
      tool_name: GoatTaskToolName | null;
      tool_call_id: string | null;
      response_to_message_id: string | null;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    };

export type GoatTaskRunEventInput =
  | GoatTaskEvent
  | {
      id: number;
      task_id: string;
      user_workos_id: string;
      message_id: string | null;
      type: GoatTaskEventType;
      payload: Record<string, unknown>;
      created_at: string;
    };

export type GoatHarnessRunViewModel = {
  hasDurableRun: boolean;
  legacyDetailText: string;
  task: {
    id: string;
    displayId: string;
    name: string;
    prompt: string;
    model: string;
    status: GoatTaskStatus;
    stage: GoatTaskStage;
    result: string;
    error: string;
    createdAt: string;
    updatedAt: string;
  };
  userMessage: GoatRunMessage | null;
  assistantMessages: GoatRunMessage[];
  toolCalls: GoatHarnessRunToolCall[];
  events: GoatRunEvent[];
};

export type GoatRunMessage = {
  id: string;
  role: GoatTaskMessageRole;
  status: GoatTaskMessageStatus;
  content: string;
  toolName: GoatTaskToolName | null;
  toolCallId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type GoatRunEvent = {
  id: number;
  messageId: string | null;
  type: GoatTaskEventType;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type GoatHarnessRunToolCall = {
  id: string;
  name: GoatTaskToolName | string;
  label: string;
  kind: "search" | "gmail" | "calendar" | "linear" | "tool";
  status: "running" | "completed" | "failed";
  inputPreview: string;
  outputPreview: string;
  errorPreview: string;
  rawJson: string;
  createdAt: string;
};

const PREVIEW_MAX_LENGTH = 900;

export function buildGoatHarnessRun(input: {
  task: GoatTaskRunTaskInput;
  messages: readonly GoatTaskRunMessageInput[];
  events: readonly GoatTaskRunEventInput[];
}): GoatHarnessRunViewModel {
  const task = normalizeTask(input.task);
  const messages = input.messages.map(normalizeMessage).toSorted(compareCreatedAt);
  const events = input.events.map(normalizeEvent).toSorted((a, b) => a.id - b.id);
  const userMessage = messages.find((message) => message.role === "user") ?? null;
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const toolCalls = buildToolCalls(events);

  return {
    hasDurableRun: messages.length > 0 || events.length > 0,
    legacyDetailText: "Detailed run events are available for new tasks only.",
    task,
    userMessage,
    assistantMessages,
    toolCalls,
    events,
  };
}

function buildToolCalls(events: readonly GoatRunEvent[]) {
  const byCallId = new Map<string, GoatHarnessRunToolCall>();
  for (const event of events) {
    if (
      event.type !== "tool.started" &&
      event.type !== "tool.completed" &&
      event.type !== "tool.failed"
    ) {
      continue;
    }
    const toolCallId = readString(event.payload.toolCallId) || `tool-${event.id}`;
    const toolName = readString(event.payload.toolName) || "tool";
    const current =
      byCallId.get(toolCallId) ??
      makeToolCall({
        id: toolCallId,
        name: toolName,
        status: "running",
        input: event.payload.input,
        output: null,
        error: null,
        raw: event.payload,
        createdAt: event.createdAt,
      });

    if (event.type === "tool.completed") {
      byCallId.set(
        toolCallId,
        makeToolCall({
          ...current,
          status: "completed",
          input: event.payload.input ?? parsePreview(current.inputPreview),
          output: event.payload.output,
          error: null,
          raw: event.payload,
          createdAt: current.createdAt,
        }),
      );
    } else if (event.type === "tool.failed") {
      byCallId.set(
        toolCallId,
        makeToolCall({
          ...current,
          status: "failed",
          input: event.payload.input ?? parsePreview(current.inputPreview),
          output: null,
          error: event.payload.error,
          raw: event.payload,
          createdAt: current.createdAt,
        }),
      );
    } else {
      byCallId.set(toolCallId, current);
    }
  }

  return Array.from(byCallId.values()).toSorted(compareCreatedAt);
}

function makeToolCall(input: {
  id: string;
  name: string;
  status: GoatHarnessRunToolCall["status"];
  input: unknown;
  output: unknown;
  error: unknown;
  raw: unknown;
  createdAt: string;
}): GoatHarnessRunToolCall {
  const description = describeTool(input.name);
  return {
    id: input.id,
    name: input.name,
    label: description.label,
    kind: description.kind,
    status: input.status,
    inputPreview: previewValue(input.input),
    outputPreview: previewValue(input.output),
    errorPreview: previewValue(input.error),
    rawJson: prettyJson(input.raw),
    createdAt: input.createdAt,
  };
}

function describeTool(name: string): Pick<GoatHarnessRunToolCall, "label" | "kind"> {
  if (name === "exa_search") return { label: "Web search", kind: "search" };
  if (name.startsWith("gmail_")) {
    const labels: Record<string, string> = {
      gmail_search: "Gmail search",
      gmail_get_message: "Gmail message",
      gmail_list_threads: "Gmail threads",
      gmail_get_thread: "Gmail thread",
    };
    return { label: labels[name] ?? "Gmail", kind: "gmail" };
  }
  if (name.startsWith("calendar_")) {
    const labels: Record<string, string> = {
      calendar_list_calendars: "Calendars",
      calendar_list_events: "Calendar events",
      calendar_get_event: "Calendar event",
      calendar_get_freebusy: "Free/busy",
    };
    return { label: labels[name] ?? "Calendar", kind: "calendar" };
  }
  if (name.startsWith("linear_")) {
    const labels: Record<string, string> = {
      linear_search_tools: "Linear tools",
      linear_use_tool: "Linear",
    };
    return { label: labels[name] ?? "Linear", kind: "linear" };
  }
  return { label: name, kind: "tool" };
}

function normalizeTask(task: GoatTaskRunTaskInput): GoatHarnessRunViewModel["task"] {
  if ("displayId" in task) {
    return {
      id: task.id,
      displayId: task.displayId,
      name: task.name,
      prompt: task.prompt,
      model: task.model,
      status: task.status,
      stage: task.stage,
      result: task.result ?? "",
      error: task.error ?? "",
      createdAt: serializeDate(task.createdAt),
      updatedAt: serializeDate(task.updatedAt),
    };
  }
  return {
    id: task.id,
    displayId: task.display_id,
    name: task.name,
    prompt: task.prompt,
    model: task.model,
    status: task.status,
    stage: task.stage,
    result: task.result ?? "",
    error: task.error ?? "",
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

function normalizeMessage(message: GoatTaskRunMessageInput): GoatRunMessage {
  if ("taskId" in message) {
    return {
      id: message.id,
      role: message.role,
      status: message.status,
      content: message.content,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      createdAt: serializeDate(message.createdAt),
      updatedAt: serializeDate(message.updatedAt),
      completedAt: message.completedAt ? serializeDate(message.completedAt) : null,
    };
  }
  return {
    id: message.id,
    role: message.role,
    status: message.status,
    content: message.content,
    toolName: message.tool_name,
    toolCallId: message.tool_call_id,
    createdAt: message.created_at,
    updatedAt: message.updated_at,
    completedAt: message.completed_at,
  };
}

function normalizeEvent(event: GoatTaskRunEventInput): GoatRunEvent {
  if ("taskId" in event) {
    return {
      id: event.id,
      messageId: event.messageId,
      type: event.type,
      payload: event.payload,
      createdAt: serializeDate(event.createdAt),
    };
  }
  return {
    id: event.id,
    messageId: event.message_id,
    type: event.type,
    payload: event.payload,
    createdAt: event.created_at,
  };
}

function compareCreatedAt(a: { createdAt: string }, b: { createdAt: string }) {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function serializeDate(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function previewValue(value: unknown) {
  if (value == null || value === "") return "";
  const text = typeof value === "string" ? value : prettyJson(value);
  const compact = text.trim();
  if (compact.length <= PREVIEW_MAX_LENGTH) return compact;
  return `${compact.slice(0, PREVIEW_MAX_LENGTH - 3)}...`;
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parsePreview(preview: string) {
  if (!preview) return null;
  try {
    return JSON.parse(preview) as unknown;
  } catch {
    return preview;
  }
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}
