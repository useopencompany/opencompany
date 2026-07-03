import type { GoatTask } from "@opencompany/db/goat-schema";

export type GoatTaskHarnessRunInput = Pick<
  GoatTask,
  "prompt" | "model" | "status" | "stage" | "result" | "error" | "harnessSpec" | "debugTrace"
>;

export type GoatHarnessRunViewModel = {
  hasTrace: boolean;
  task: {
    prompt: string;
    model: string;
    status: string;
    stage: string;
    resultPreview: string;
    errorPreview: string;
  };
  summary: {
    plannerModel: string;
    harnessModel: string;
    turnCount: number;
    toolCallCount: number;
  };
  planner: GoatHarnessPlannerRun | null;
  harness: GoatHarnessModelRun | null;
  harnessSpecJson: string;
  rawTraceJson: string;
};

export type GoatHarnessPlannerRun = {
  model: string;
  requestMessages: GoatHarnessRunMessage[];
  responsePreview: string;
  rawJson: string;
};

export type GoatHarnessModelRun = {
  model: string;
  systemPromptPreview: string;
  toolChoice: string;
  toolsSentToModelPreview: string;
  turns: GoatHarnessRunTurn[];
  rawJson: string;
};

export type GoatHarnessRunTurn = {
  step: number;
  requestMessages: GoatHarnessRunMessage[];
  responseMessage: GoatHarnessRunMessage | null;
  toolCalls: GoatHarnessRunToolCall[];
  rawJson: string;
};

export type GoatHarnessRunMessage = {
  role: string;
  contentPreview: string;
  toolCalls: GoatHarnessRunToolCall[];
};

export type GoatHarnessRunToolCall = {
  id: string;
  name: string;
  label: string;
  kind: "search" | "gmail" | "calendar" | "result" | "tool";
  status: "running" | "completed" | "failed";
  inputPreview: string;
  outputPreview: string;
  errorPreview: string;
  rawJson: string;
};

const PREVIEW_MAX_LENGTH = 900;

export function buildGoatHarnessRun(input: GoatTaskHarnessRunInput): GoatHarnessRunViewModel {
  const debugTrace = readRecord(input.debugTrace);
  const planner = buildPlannerRun(readRecord(debugTrace?.planner));
  const harness = buildModelRun(readRecord(debugTrace?.harness));
  const turnCount = harness?.turns.length ?? 0;
  const toolCallCount =
    harness?.turns.reduce((total, turn) => total + turn.toolCalls.length, 0) ?? 0;

  return {
    hasTrace: Boolean(planner || harness),
    task: {
      prompt: input.prompt,
      model: input.model,
      status: input.status,
      stage: input.stage,
      resultPreview: previewValue(input.result),
      errorPreview: previewValue(input.error),
    },
    summary: {
      plannerModel: planner?.model ?? "",
      harnessModel: harness?.model ?? "",
      turnCount,
      toolCallCount,
    },
    planner,
    harness,
    harnessSpecJson: prettyJson(input.harnessSpec),
    rawTraceJson: prettyJson({
      harnessSpec: input.harnessSpec,
      debugTrace: input.debugTrace,
    }),
  };
}

function buildPlannerRun(planner: Record<string, unknown> | null): GoatHarnessPlannerRun | null {
  if (!planner) return null;
  const request = readRecord(planner.request);
  const requestMessages = readMessages(request?.messages);
  const response = readRecord(planner.response);
  const responsePreview = previewValue(response?.content);
  const model = readString(planner.model);

  if (!model && requestMessages.length === 0 && !responsePreview) return null;

  return {
    model,
    requestMessages,
    responsePreview,
    rawJson: prettyJson(planner),
  };
}

function buildModelRun(harness: Record<string, unknown> | null): GoatHarnessModelRun | null {
  if (!harness) return null;
  const turns = Array.isArray(harness.turns)
    ? harness.turns.map(buildRunTurn).filter((turn): turn is GoatHarnessRunTurn => Boolean(turn))
    : [];
  const model = readString(harness.model);
  const systemPromptPreview = previewValue(harness.systemPrompt);
  const toolChoice = readString(harness.toolChoice);
  const toolsSentToModelPreview = previewValue(harness.toolsSentToModel);

  if (!model && !systemPromptPreview && turns.length === 0) return null;

  return {
    model,
    systemPromptPreview,
    toolChoice,
    toolsSentToModelPreview,
    turns,
    rawJson: prettyJson(harness),
  };
}

function buildRunTurn(value: unknown): GoatHarnessRunTurn | null {
  const turn = readRecord(value);
  if (!turn) return null;
  const responseMessage = readMessage(turn.responseMessage);
  const responseToolCalls = responseMessage?.toolCalls ?? [];
  const toolResults = readToolResults(turn.toolResults);
  const toolCalls = mergeToolCalls(responseToolCalls, toolResults);
  const requestMessages = readMessages(turn.requestMessages);

  if (requestMessages.length === 0 && !responseMessage && toolCalls.length === 0) {
    return null;
  }

  return {
    step: readNumber(turn.step) ?? 0,
    requestMessages,
    responseMessage,
    toolCalls,
    rawJson: prettyJson(turn),
  };
}

function mergeToolCalls(
  responseToolCalls: GoatHarnessRunToolCall[],
  toolResults: GoatHarnessRunToolCall[],
) {
  const resultById = new Map(toolResults.map((tool) => [tool.id, tool]));
  const renderedIds = new Set<string>();
  const merged = responseToolCalls.map((toolCall) => {
    renderedIds.add(toolCall.id);
    const result = resultById.get(toolCall.id);
    return result
      ? {
          ...toolCall,
          status: result.status,
          outputPreview: result.outputPreview,
          errorPreview: result.errorPreview,
          rawJson: result.rawJson,
        }
      : toolCall;
  });

  for (const result of toolResults) {
    if (!renderedIds.has(result.id)) merged.push(result);
  }

  return merged;
}

function readMessages(value: unknown): GoatHarnessRunMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    const parsed = readMessage(message);
    return parsed ? [parsed] : [];
  });
}

function readMessage(value: unknown): GoatHarnessRunMessage | null {
  const message = readRecord(value);
  if (!message) return null;
  const role = readString(message.role) || "message";
  const contentPreview = previewValue(message.content);
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .map(readToolCall)
        .filter((tool): tool is GoatHarnessRunToolCall => Boolean(tool))
    : [];

  if (!contentPreview && toolCalls.length === 0) return null;

  return {
    role,
    contentPreview,
    toolCalls,
  };
}

function readToolCall(value: unknown): GoatHarnessRunToolCall | null {
  const toolCall = readRecord(value);
  if (!toolCall) return null;
  const fn = readRecord(toolCall.function);
  const name = readString(fn?.name) || "tool_call";
  const id = readString(toolCall.id) || `tool:${name}`;
  const args = parseToolArguments(fn?.arguments);

  return makeToolCall({
    id,
    name,
    status: "running",
    input: args,
    output: null,
    error: null,
    raw: toolCall,
  });
}

function readToolResults(value: unknown): GoatHarnessRunToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = readRecord(item);
    if (!record) return [];
    const name = readString(record.name) || "tool_call";
    const id = readString(record.toolCallId) || `tool:${name}`;
    const error = readString(record.error);
    return [
      makeToolCall({
        id,
        name,
        status: error ? "failed" : "completed",
        input: record.args,
        output: record.result,
        error,
        raw: record,
      }),
    ];
  });
}

function makeToolCall(input: {
  id: string;
  name: string;
  status: GoatHarnessRunToolCall["status"];
  input: unknown;
  output: unknown;
  error: string | null;
  raw: unknown;
}): GoatHarnessRunToolCall {
  const display = describeTool(input.name);
  return {
    id: input.id,
    name: input.name,
    label: display.label,
    kind: display.kind,
    status: input.status,
    inputPreview: previewValue(input.input),
    outputPreview: previewValue(input.output),
    errorPreview: previewValue(input.error),
    rawJson: prettyJson(input.raw),
  };
}

function describeTool(name: string): Pick<GoatHarnessRunToolCall, "label" | "kind"> {
  if (name === "exa_search") return { label: "Web search", kind: "search" };
  if (name === "gmail_search") return { label: "Search Gmail", kind: "gmail" };
  if (name === "gmail_get_message") return { label: "Read email", kind: "gmail" };
  if (name === "gmail_list_threads") return { label: "List email threads", kind: "gmail" };
  if (name === "gmail_get_thread") return { label: "Read email thread", kind: "gmail" };
  if (name === "calendar_list_calendars") return { label: "List calendars", kind: "calendar" };
  if (name === "calendar_list_events") return { label: "List calendar events", kind: "calendar" };
  if (name === "calendar_get_event") return { label: "Read calendar event", kind: "calendar" };
  if (name === "calendar_get_freebusy") return { label: "Check availability", kind: "calendar" };
  if (name === "goat_result") return { label: "Final result", kind: "result" };
  return { label: formatToolName(name), kind: "tool" };
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!value.trim()) return "";
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function prettyJson(value: unknown) {
  if (value == null) return "";
  if (Array.isArray(value) && value.length === 0) return "";
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  ) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function previewValue(value: unknown) {
  const text = typeof value === "string" ? value.trim() : prettyJson(value).trim();
  return truncatePreview(text);
}

function truncatePreview(value: string) {
  if (value.length <= PREVIEW_MAX_LENGTH) return value;
  return `${value.slice(0, PREVIEW_MAX_LENGTH - 3).trimEnd()}...`;
}

function formatToolName(name: string) {
  return name
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
