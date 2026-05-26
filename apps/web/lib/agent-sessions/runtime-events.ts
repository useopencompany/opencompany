export type SessionMessage = {
  id: string;
  role: string;
  content: string;
  status: string;
  internal?: boolean;
  modelMessage?: Record<string, unknown> | null;
  toolName?: string | null;
  toolCallId?: string | null;
  outputReasoningTokens?: number | undefined;
  createdAt?: string | undefined;
  completedAt?: string | null | undefined;
  thinkingDurationSeconds?: number | undefined;
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

export type SessionCostSummary = {
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  totalCostUsdMicros: number;
  modelCostUsdMicros: number;
  toolCostUsdMicros: number;
};

export type SessionRuntimeState = {
  events: RuntimeEvent[];
  messages: SessionMessage[];
  usage: SessionUsageSummary;
  toolUsage: SessionToolUsageSummary;
  cost: SessionCostSummary;
  currentStatus: string;
  lastError: string | null;
};

export type RuntimeToolCall = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  inputPreview: string;
  activityPreview: string;
  outputPreview: string;
  brainPath?: string | undefined;
  startedEventId: number | null;
  completedEventId: number | null;
};

export type AssistantTurnPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string | undefined; durationSeconds: number }
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
    const messageId = readString(event.payload.messageId);
    const outputReasoningTokens = readNumber(event.payload.outputReasoningTokens);
    next = {
      ...next,
      usage: addUsageSummary(next.usage, event.payload),
      cost: addCostSummary(next.cost, event.payload, "model"),
      messages: messageId
        ? next.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  outputReasoningTokens:
                    (message.outputReasoningTokens ?? 0) + outputReasoningTokens,
                }
              : message,
          )
        : next.messages,
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
        cost: addCostSummary(next.cost, event.payload, "tool"),
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
        messages: [
          ...next.messages,
          {
            id: messageId,
            role,
            content: "",
            status: "running",
            internal: readBoolean(event.payload.internal),
            createdAt: new Date().toISOString(),
          },
        ],
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
      const completedAt = new Date().toISOString();
      next = {
        ...next,
        messages: next.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                status: "completed",
                content: content ?? message.content,
                completedAt,
                thinkingDurationSeconds: readThinkingDurationSeconds({
                  ...message,
                  completedAt,
                }),
                ...(modelMessage ? { modelMessage } : {}),
              }
            : message,
        ),
      };
    }
  }

  return next;
}

function readBoolean(value: unknown) {
  return value === true;
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

export function emptyCostSummary(): SessionCostSummary {
  return {
    providerCostUsdMicros: 0,
    platformFeeUsdMicros: 0,
    totalCostUsdMicros: 0,
    modelCostUsdMicros: 0,
    toolCostUsdMicros: 0,
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

function addCostSummary(
  totals: SessionCostSummary,
  payload: Record<string, unknown>,
  kind: "model" | "tool",
): SessionCostSummary {
  const providerCostUsdMicros = readNumber(
    payload.providerCostUsdMicros ?? (kind === "tool" ? payload.costUsdMicros : 0),
  );
  const platformFeeUsdMicros = readNumber(payload.platformFeeUsdMicros);
  const totalCostUsdMicros = readNumber(
    payload.chargedCostUsdMicros ?? providerCostUsdMicros + platformFeeUsdMicros,
  );

  return {
    providerCostUsdMicros: totals.providerCostUsdMicros + providerCostUsdMicros,
    platformFeeUsdMicros: totals.platformFeeUsdMicros + platformFeeUsdMicros,
    totalCostUsdMicros: totals.totalCostUsdMicros + totalCostUsdMicros,
    modelCostUsdMicros: totals.modelCostUsdMicros + (kind === "model" ? totalCostUsdMicros : 0),
    toolCostUsdMicros: totals.toolCostUsdMicros + (kind === "tool" ? totalCostUsdMicros : 0),
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
  const reasoningSummary = readReasoningSummary(events, message.id);
  const reasoningTokenCount = message.outputReasoningTokens ?? 0;
  const thinkingDurationSeconds =
    message.thinkingDurationSeconds ?? readThinkingDurationSeconds(message);
  const reasoningParts: AssistantTurnPart[] =
    reasoningSummary || reasoningTokenCount > 0
      ? [
          {
            type: "reasoning",
            text: reasoningSummary || undefined,
            durationSeconds: thinkingDurationSeconds,
          },
        ]
      : [];

  if (modelParts) {
    const turnParts: AssistantTurnPart[] = [...reasoningParts];

    for (const part of modelParts) {
      if (part.type === "text") {
        const text = readString(part.text);
        if (text) turnParts.push({ type: "text", text });
        continue;
      }

      if (part.type !== "tool-call") continue;

      const toolCallId = readString(part.toolCallId);
      if (!toolCallId) continue;
      const matchingToolCall = toolCallsById.get(toolCallId);
      const brainPath = matchingToolCall?.brainPath ?? brainPathForToolCallPart(part);

      turnParts.push({
        type: "tool-call",
        toolCall: {
          id: toolCallId,
          name: readString(part.toolName) || "Tool call",
          status: matchingToolCall?.status ?? "completed",
          inputPreview:
            formatRuntimePreview(part.input) ||
            formatRuntimePreview(part.args) ||
            matchingToolCall?.inputPreview ||
            "",
          activityPreview: matchingToolCall?.activityPreview ?? "",
          outputPreview:
            matchingToolCall?.outputPreview || toolResultsByCallId.get(toolCallId) || "",
          ...(brainPath ? { brainPath } : {}),
          startedEventId: matchingToolCall?.startedEventId ?? null,
          completedEventId: matchingToolCall?.completedEventId ?? null,
        },
      });
    }

    return turnParts;
  }

  const eventParts = buildEventAssistantTurnParts(events, message.id, toolCallsById);
  if (eventParts.length > 0) return [...reasoningParts, ...eventParts];
  if (reasoningParts.length > 0 && message.content) {
    return [...reasoningParts, { type: "text", text: message.content }];
  }
  if (reasoningParts.length > 0) return reasoningParts;
  return message.content ? [{ type: "text", text: message.content }] : [];
}

export function buildBackgroundActivityParts(
  events: RuntimeEvent[],
  messages: SessionMessage[],
): AssistantTurnPart[] {
  const partsWithOrder: Array<{ order: number; part: AssistantTurnPart }> = [];

  for (const toolCall of buildAfterSessionLifecycleToolCalls(events)) {
    partsWithOrder.push({
      order: toolCall.startedEventId ?? toolCall.completedEventId ?? Number.MAX_SAFE_INTEGER,
      part: { type: "tool-call", toolCall },
    });
  }

  for (const message of messages) {
    if (message.role !== "assistant" || !message.internal) continue;

    const messageParts = buildAssistantTurnParts(message, events, messages);
    for (const part of messageParts) {
      if (part.type !== "tool-call") continue;
      partsWithOrder.push({
        order:
          part.toolCall.startedEventId ??
          part.toolCall.completedEventId ??
          eventOrderForMessage(events, message.id) ??
          Number.MAX_SAFE_INTEGER,
        part,
      });
    }
  }

  return partsWithOrder.sort((left, right) => left.order - right.order).map((item) => item.part);
}

function buildAfterSessionLifecycleToolCalls(events: RuntimeEvent[]) {
  const calls: RuntimeToolCall[] = [];
  const callsByKey = new Map<string, RuntimeToolCall>();
  const callsByMessageId = new Map<string, RuntimeToolCall>();

  function getCall(input: { runId: string; messageId: string }) {
    const key = input.runId || input.messageId;
    const existing =
      (input.runId ? callsByKey.get(input.runId) : undefined) ||
      (input.messageId ? callsByMessageId.get(input.messageId) : undefined);
    if (existing) {
      if (input.runId) callsByKey.set(input.runId, existing);
      if (input.messageId) callsByMessageId.set(input.messageId, existing);
      return existing;
    }

    const call: RuntimeToolCall = {
      id: `after-session:${key}`,
      name: "after_session",
      status: "running",
      inputPreview: "",
      activityPreview: "",
      outputPreview: "",
      startedEventId: null,
      completedEventId: null,
    };
    calls.push(call);
    if (input.runId) callsByKey.set(input.runId, call);
    if (input.messageId) callsByMessageId.set(input.messageId, call);
    return call;
  }

  for (const event of events) {
    if (!event.type.startsWith("after_session.")) continue;
    if (event.type === "after_session.skipped") continue;

    const runId = readEventKey(event.payload.runId);
    const messageId = readString(event.payload.messageId);
    if (!runId && !messageId) continue;

    const call = getCall({ runId, messageId });
    if (event.type === "after_session.started") {
      call.status = "running";
      call.startedEventId = event.id;
    }
    if (event.type === "after_session.completed") {
      call.status = "completed";
      call.outputPreview = "Completed";
      call.completedEventId = event.id;
    }
    if (event.type === "after_session.failed") {
      call.status = "failed";
      call.outputPreview = readString(event.payload.message) || "After-session run failed.";
      call.completedEventId = event.id;
    }
  }

  return calls;
}

function readEventKey(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function eventOrderForMessage(events: RuntimeEvent[], messageId: string) {
  const event = events.find((item) => item.messageId === messageId);
  return event?.id;
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

    if (event.type === "file.changed") {
      const brainPath = normalizeBrainWorkspacePath(readString(event.payload.path));
      const call = brainPath ? findLatestToolCall(calls, "write_file") : null;
      if (brainPath && call) {
        call.brainPath = brainPath;
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
      const brainPath = brainPathForToolPayload(call.name, event.payload.input);
      if (brainPath) {
        call.brainPath = brainPath;
      }
      call.startedEventId = event.id;
    }

    if (event.type === "tool.completed" || event.type === "tool.failed") {
      const call = getCall(toolCallId);
      call.name = readString(event.payload.name) || call.name;
      call.status = event.type === "tool.failed" ? "failed" : "completed";
      call.outputPreview =
        event.type === "tool.failed"
          ? formatRuntimePreview(event.payload.error || event.payload.output)
          : formatRuntimePreview(event.payload.output);
      const brainPath = brainPathForToolPayload(call.name, event.payload.output);
      if (brainPath) {
        call.brainPath = brainPath;
      }
      call.completedEventId = event.id;
    }
  }

  const latestSessionError = latestSessionErrorAfter(events, messageId);
  if (latestSessionError) {
    const latestRunningCall = [...calls]
      .reverse()
      .find(
        (call) => call.status === "running" && (call.startedEventId ?? 0) < latestSessionError.id,
      );
    if (latestRunningCall) {
      latestRunningCall.status = "failed";
      latestRunningCall.outputPreview =
        formatRuntimePreview({ message: readString(latestSessionError.payload.message) }) ||
        "The session failed before this tool returned a result.";
      latestRunningCall.completedEventId = latestSessionError.id;
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
      event.type === "tool.completed" ||
      event.type === "tool.failed"
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

function latestSessionErrorAfter(events: RuntimeEvent[], messageId: string) {
  let latestToolEventId = 0;

  for (const event of events) {
    if (eventBelongsToMessage(event, messageId) && event.type === "tool.started") {
      latestToolEventId = Math.max(latestToolEventId, event.id);
    }
  }

  let latestError: RuntimeEvent | null = null;
  for (const event of events) {
    if (event.type === "session.error" && event.id > latestToolEventId) {
      latestError = event;
    }
  }
  return latestToolEventId > 0 ? latestError : null;
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

function brainPathForToolCallPart(part: Record<string, unknown>) {
  const name = readString(part.toolName);
  return (
    brainPathForToolPayload(name, part.input) ||
    brainPathForToolPayload(name, part.args) ||
    undefined
  );
}

function brainPathForToolPayload(name: string, payload: unknown) {
  if (name !== "write_file" || !isRecord(payload)) return undefined;
  return normalizeBrainWorkspacePath(payload.path);
}

function normalizeBrainWorkspacePath(value: unknown) {
  if (typeof value !== "string") return undefined;
  const path = value.trim().replace(/^\.?\//, "");
  if (!path.startsWith("brain/")) return undefined;
  const brainPath = path.slice("brain/".length);
  return brainPath || undefined;
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

function readReasoningSummary(events: RuntimeEvent[], messageId: string) {
  return events
    .filter((event) => event.type === "message.reasoning_summary")
    .filter((event) => eventBelongsToMessage(event, messageId))
    .map((event) => readString(event.payload.summary).trim())
    .filter(Boolean)
    .join("\n\n");
}

function readThinkingDurationSeconds(message: SessionMessage) {
  const startedAt = readTimestamp(message.createdAt);
  const completedAt = readTimestamp(message.completedAt);
  if (!startedAt || !completedAt || completedAt < startedAt) return 1;
  const durationSeconds = Math.round((completedAt - startedAt) / 1000);
  return Math.max(durationSeconds, 1);
}

function readTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
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
