export type SessionMessage = {
  id: string;
  role: string;
  content: string;
  status: string;
  modelMessage?: Record<string, unknown> | null;
  toolName?: string | null;
  toolCallId?: string | null;
};

export type RuntimeEvent = {
  id: number;
  type: string;
  messageId: string | null;
  payload: Record<string, unknown>;
};

export type SessionUsageSummary = {
  inputTokens: number;
  inputNoCacheTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
  outputTextTokens: number;
  outputReasoningTokens: number;
  totalTokens: number;
};

export type SessionToolUsageSummary = {
  totalCostUsdMicros: number;
  byProviderOperation: Array<{
    provider: string;
    operation: string;
    costUsdMicros: number;
    calls: number;
  }>;
};

export type SessionRuntimeState = {
  events: RuntimeEvent[];
  messages: SessionMessage[];
  usage: SessionUsageSummary;
  toolUsage: SessionToolUsageSummary;
  currentStatus: string;
  lastError: string | null;
};

export type RuntimeToolCall = {
  id: string;
  name: string;
  status: "running" | "completed";
  inputPreview: string;
  activityPreview: string;
  outputPreview: string;
  startedEventId: number | null;
  completedEventId: number | null;
};

export type AssistantTurnPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCall: RuntimeToolCall };

export function applyRuntimeEventToState(
  state: SessionRuntimeState,
  event: RuntimeEvent,
): SessionRuntimeState {
  if (state.events.some((item) => item.id === event.id)) return state;

  let next: SessionRuntimeState = {
    ...state,
    events: [...state.events, event],
  };

  if (event.type === "session.status") {
    const status = readString(event.payload.status);
    if (status) {
      next = {
        ...next,
        currentStatus: status,
        lastError: status === "failed" ? next.lastError : null,
      };
    }
  }

  if (event.type === "session.error") {
    const message = readString(event.payload.message);
    next = {
      ...next,
      currentStatus: "failed",
      lastError: message || "The session failed.",
    };
  }

  if (event.type === "session.usage") {
    next = {
      ...next,
      usage: addUsageSummary(next.usage, event.payload),
    };
  }

  if (event.type === "session.tool_usage") {
    const provider = readString(event.payload.provider);
    const operation = readString(event.payload.operation);
    const costUsdMicros = readNumber(event.payload.costUsdMicros);
    if (provider && operation) {
      const key = `${provider}:${operation}`;
      let matched = false;
      const byProviderOperation = next.toolUsage.byProviderOperation.map((item) => {
        if (`${item.provider}:${item.operation}` !== key) return item;
        matched = true;
        return {
          ...item,
          costUsdMicros: item.costUsdMicros + costUsdMicros,
          calls: item.calls + 1,
        };
      });
      if (!matched) {
        byProviderOperation.push({ provider, operation, costUsdMicros, calls: 1 });
      }

      next = {
        ...next,
        toolUsage: {
          totalCostUsdMicros: next.toolUsage.totalCostUsdMicros + costUsdMicros,
          byProviderOperation: byProviderOperation.sort((left, right) =>
            `${left.provider}:${left.operation}`.localeCompare(
              `${right.provider}:${right.operation}`,
            ),
          ),
        },
      };
    }
  }

  if (event.type === "message.created") {
    const messageId = readString(event.payload.messageId);
    const role = readString(event.payload.role);
    if (messageId && role && !next.messages.some((message) => message.id === messageId)) {
      next = {
        ...next,
        messages: [...next.messages, { id: messageId, role, content: "", status: "running" }],
      };
    }
  }

  if (event.type === "message.delta") {
    const messageId = readString(event.payload.messageId);
    const delta = readString(event.payload.delta);
    if (messageId && delta) {
      next = {
        ...next,
        messages: next.messages.map((message) =>
          message.id === messageId
            ? { ...message, content: `${message.content}${delta}` }
            : message,
        ),
      };
    }
  }

  if (event.type === "message.completed") {
    const messageId = readString(event.payload.messageId);
    const content = optionalString(event.payload.content);
    const modelMessage = isRecord(event.payload.modelMessage) ? event.payload.modelMessage : null;
    if (messageId) {
      next = {
        ...next,
        messages: next.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                status: "completed",
                content: content ?? message.content,
                ...(modelMessage ? { modelMessage } : {}),
              }
            : message,
        ),
      };
    }
  }

  return next;
}

export function emptyUsageSummary(): SessionUsageSummary {
  return {
    inputTokens: 0,
    inputNoCacheTokens: 0,
    inputCacheReadTokens: 0,
    inputCacheWriteTokens: 0,
    outputTokens: 0,
    outputTextTokens: 0,
    outputReasoningTokens: 0,
    totalTokens: 0,
  };
}

function addUsageSummary(
  totals: SessionUsageSummary,
  usage: Partial<Record<keyof SessionUsageSummary, unknown>>,
): SessionUsageSummary {
  return {
    inputTokens: totals.inputTokens + readNumber(usage.inputTokens),
    inputNoCacheTokens: totals.inputNoCacheTokens + readNumber(usage.inputNoCacheTokens),
    inputCacheReadTokens: totals.inputCacheReadTokens + readNumber(usage.inputCacheReadTokens),
    inputCacheWriteTokens: totals.inputCacheWriteTokens + readNumber(usage.inputCacheWriteTokens),
    outputTokens: totals.outputTokens + readNumber(usage.outputTokens),
    outputTextTokens: totals.outputTextTokens + readNumber(usage.outputTextTokens),
    outputReasoningTokens: totals.outputReasoningTokens + readNumber(usage.outputReasoningTokens),
    totalTokens: totals.totalTokens + readNumber(usage.totalTokens),
  };
}

export function isInspectableRuntimeEvent(event: RuntimeEvent) {
  return event.type !== "message.delta";
}

export function buildAssistantTurnParts(
  message: SessionMessage,
  events: RuntimeEvent[],
  messages: SessionMessage[] = [],
): AssistantTurnPart[] {
  const toolResultsByCallId = buildToolResultsByCallId(messages);
  const toolCalls = buildRuntimeToolCallsForMessage(events, message.id).map((toolCall) => {
    const outputPreview = toolCall.outputPreview || toolResultsByCallId.get(toolCall.id) || "";
    return {
      ...toolCall,
      status: outputPreview ? ("completed" as const) : toolCall.status,
      outputPreview,
    };
  });
  const toolCallsById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const modelParts = readAssistantModelParts(message.modelMessage);

  if (modelParts) {
    const turnParts: AssistantTurnPart[] = [];

    for (const part of modelParts) {
      if (part.type === "text") {
        const text = readString(part.text);
        if (text) turnParts.push({ type: "text", text });
        continue;
      }

      if (part.type !== "tool-call") continue;

      const toolCallId = readString(part.toolCallId);
      if (!toolCallId) continue;

      turnParts.push({
        type: "tool-call",
        toolCall: {
          id: toolCallId,
          name: readString(part.toolName) || "Tool call",
          status: toolCallsById.get(toolCallId)?.status ?? "completed",
          inputPreview:
            formatRuntimePreview(part.input) ||
            formatRuntimePreview(part.args) ||
            toolCallsById.get(toolCallId)?.inputPreview ||
            "",
          activityPreview: toolCallsById.get(toolCallId)?.activityPreview ?? "",
          outputPreview:
            toolCallsById.get(toolCallId)?.outputPreview ||
            toolResultsByCallId.get(toolCallId) ||
            "",
          startedEventId: toolCallsById.get(toolCallId)?.startedEventId ?? null,
          completedEventId: toolCallsById.get(toolCallId)?.completedEventId ?? null,
        },
      });
    }

    return turnParts;
  }

  const eventParts = buildEventAssistantTurnParts(events, message.id, toolCallsById);
  if (eventParts.length > 0) return eventParts;
  return message.content ? [{ type: "text", text: message.content }] : [];
}

export function buildRuntimeToolCallsForMessage(
  events: RuntimeEvent[],
  messageId: string,
): RuntimeToolCall[] {
  const calls: RuntimeToolCall[] = [];
  const callsById = new Map<string, RuntimeToolCall>();

  function getCall(toolCallId: string) {
    const existing = callsById.get(toolCallId);
    if (existing) return existing;

    const call: RuntimeToolCall = {
      id: toolCallId,
      name: "Tool call",
      status: "running",
      inputPreview: "",
      activityPreview: "",
      outputPreview: "",
      startedEventId: null,
      completedEventId: null,
    };
    callsById.set(toolCallId, call);
    calls.push(call);
    return call;
  }

  for (const event of events) {
    if (!eventBelongsToMessage(event, messageId)) continue;

    if (event.type === "command.output") {
      const command = readString(event.payload.command);
      const delta = readString(event.payload.delta);
      const toolCallId = readString(event.payload.toolCallId);
      const call = toolCallId ? callsById.get(toolCallId) : findLatestToolCall(calls, command);
      if (call && delta) {
        call.activityPreview = truncateRuntimePreview(`${call.activityPreview}${delta}`);
      }
      continue;
    }

    const toolCallId = readString(event.payload.toolCallId);
    if (!toolCallId) continue;

    if (event.type === "tool.delta") {
      const delta = readString(event.payload.delta);
      if (delta) {
        const call = getCall(toolCallId);
        call.inputPreview = truncateRuntimePreview(`${call.inputPreview}${delta}`);
      }
    }

    if (event.type === "tool.started") {
      const call = getCall(toolCallId);
      call.name = readString(event.payload.name) || call.name;
      call.inputPreview = formatRuntimePreview(event.payload.input) || call.inputPreview;
      call.startedEventId = event.id;
    }

    if (event.type === "tool.completed") {
      const call = getCall(toolCallId);
      call.name = readString(event.payload.name) || call.name;
      call.status = "completed";
      call.outputPreview = formatRuntimePreview(event.payload.output);
      call.completedEventId = event.id;
    }
  }

  return calls.sort(
    (left, right) =>
      (left.startedEventId ?? left.completedEventId ?? 0) -
      (right.startedEventId ?? right.completedEventId ?? 0),
  );
}

function buildEventAssistantTurnParts(
  events: RuntimeEvent[],
  messageId: string,
  toolCallsById: Map<string, RuntimeToolCall>,
): AssistantTurnPart[] {
  const parts: AssistantTurnPart[] = [];
  const renderedToolCallIds = new Set<string>();
  let text = "";

  function flushText() {
    if (!text) return;
    parts.push({ type: "text", text });
    text = "";
  }

  for (const event of events) {
    if (!eventBelongsToMessage(event, messageId)) continue;

    if (event.type === "message.delta") {
      text += readString(event.payload.delta);
      continue;
    }

    if (
      event.type === "tool.delta" ||
      event.type === "tool.started" ||
      event.type === "tool.completed"
    ) {
      const toolCallId = readString(event.payload.toolCallId);
      if (!toolCallId || renderedToolCallIds.has(toolCallId)) continue;
      const toolCall = toolCallsById.get(toolCallId);
      if (!toolCall) continue;

      flushText();
      renderedToolCallIds.add(toolCallId);
      parts.push({ type: "tool-call", toolCall });
    }
  }

  flushText();
  return parts;
}

function findLatestToolCall(calls: RuntimeToolCall[], name: string) {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call?.status === "running" && call.name === name) return call;
  }

  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call?.name === name) return call;
  }

  return null;
}

function buildToolResultsByCallId(messages: SessionMessage[]) {
  const resultsByCallId = new Map<string, string>();

  for (const message of messages) {
    if (message.role !== "tool") continue;

    const toolCallId =
      message.toolCallId || readToolResultCallId(message.modelMessage) || readString(message.id);
    if (!toolCallId) continue;

    const outputPreview = readToolResultPreview(message.modelMessage) || message.content;
    if (outputPreview) resultsByCallId.set(toolCallId, formatRuntimePreview(outputPreview));
  }

  return resultsByCallId;
}

function readToolResultCallId(modelMessage: Record<string, unknown> | null | undefined) {
  const resultPart = readFirstToolResultPart(modelMessage);
  return resultPart ? readString(resultPart.toolCallId) : "";
}

function readToolResultPreview(modelMessage: Record<string, unknown> | null | undefined) {
  const resultPart = readFirstToolResultPart(modelMessage);
  if (!resultPart) return "";

  if (Object.prototype.hasOwnProperty.call(resultPart, "output")) {
    return formatToolResultOutput(resultPart.output);
  }

  if (Object.prototype.hasOwnProperty.call(resultPart, "result")) {
    return formatRuntimePreview(resultPart.result);
  }

  return "";
}

function readFirstToolResultPart(modelMessage: Record<string, unknown> | null | undefined) {
  if (!modelMessage || modelMessage.role !== "tool" || !Array.isArray(modelMessage.content)) {
    return null;
  }

  return modelMessage.content.filter(isRecord).find((part) => part.type === "tool-result") ?? null;
}

function formatToolResultOutput(output: unknown) {
  if (!isRecord(output)) return formatRuntimePreview(output);
  if (output.type === "json" && Object.prototype.hasOwnProperty.call(output, "value")) {
    return formatRuntimePreview(output.value);
  }
  if (output.type === "text" && Object.prototype.hasOwnProperty.call(output, "value")) {
    return formatRuntimePreview(output.value);
  }
  return formatRuntimePreview(output);
}

export function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function optionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readAssistantModelParts(modelMessage: Record<string, unknown> | null | undefined) {
  if (!modelMessage || modelMessage.role !== "assistant") return null;
  const content = modelMessage.content;
  if (!Array.isArray(content)) return null;
  return content.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventBelongsToMessage(event: RuntimeEvent, messageId: string) {
  return event.messageId === messageId || readString(event.payload.messageId) === messageId;
}

function formatRuntimePreview(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return truncateRuntimePreview(value);

  try {
    return truncateRuntimePreview(JSON.stringify(value, null, 2));
  } catch {
    return truncateRuntimePreview(String(value));
  }
}

function truncateRuntimePreview(value: string) {
  const trimmed = value.trim();
  const maxLength = 900;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}...`;
}
