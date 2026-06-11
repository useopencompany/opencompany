import {
  BUILTIN_USE_TOOL_NAME,
  effectiveToolCall,
  parseGitHubCliArgs,
  toolDisplayTitle,
} from "@opencompany/agent-runtime";

export type SessionMessage = {
  id: string;
  role: string;
  content: string;
  status: string;
  internal?: boolean;
  modelMessage?: Record<string, unknown> | null;
  toolName?: string | null;
  toolCallId?: string | null;
  responseToMessageId?: string | null;
  outputReasoningTokens?: number | undefined;
  createdAt?: string | undefined;
  completedAt?: string | null | undefined;
  thinkingDurationSeconds?: number | undefined;
  attachments?: Array<{
    id: string;
    kind: "image" | "pdf" | "text";
    mediaType: string;
    filename: string;
  }>;
};

export type RuntimeEvent = {
  id: number | null;
  type: string;
  messageId: string | null;
  payload: Record<string, unknown>;
  createdAt?: string;
  transient?: boolean;
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
  sandboxCostUsdMicros: number;
};

export type SessionRuntimeState = {
  events: RuntimeEvent[];
  messages: SessionMessage[];
  usage: SessionUsageSummary;
  toolUsage: SessionToolUsageSummary;
  cost: SessionCostSummary;
  currentStatus: string;
  lastError: string | null;
  // True once the stream has reduced an event that establishes the session's
  // status/error — a `session.status`, a `session.error`, or a non-internal user
  // `message.created`. Until then `currentStatus`/`lastError` are still the empty
  // seed and must NOT be trusted over the Postgres snapshot. The view reads this to
  // decide when the live stream is authoritative for the scalar health signals (a
  // token/usage delta alone leaves it false), so the displayed status/error can
  // never momentarily regress to the seed and flicker. See the merge in SessionView.
  statusObserved: boolean;
};

export type SessionAggregateSnapshot = {
  usage: SessionUsageSummary;
  toolUsage: SessionToolUsageSummary;
  cost: SessionCostSummary;
  currentContextTokens: number;
};

/**
 * Union-merge a durable server snapshot (the Postgres system-of-record, complete
 * but as-of fetch time) with the live Durable-Stream overlay. The snapshot is the
 * floor: a message present only in the snapshot — e.g. a user message that only the
 * web's best-effort stream append was meant to publish, or any history that predates
 * the stream — is never dropped. The overlay's copy of a shared message wins (it
 * carries live deltas/status); messages new since the snapshot are appended in
 * stream order (they are chronologically newer). Keyed by message id.
 */
export function mergeMessages(
  snapshot: SessionMessage[],
  overlay: SessionMessage[],
): SessionMessage[] {
  const overlayById = new Map(overlay.map((message) => [message.id, message]));
  const merged: SessionMessage[] = [];
  const seen = new Set<string>();
  for (const message of snapshot) {
    merged.push(overlayById.get(message.id) ?? message);
    seen.add(message.id);
  }
  for (const message of overlay) {
    if (!seen.has(message.id)) merged.push(message);
  }
  return merged;
}

/**
 * Union-merge snapshot events with the live overlay. Durable events (numeric id)
 * are deduped by id with the overlay copy preferred; transient events (id `null`,
 * token/reasoning deltas) exist only on the overlay and are appended in stream
 * order. The snapshot prefix stays ordered; overlay-only events (newer durable +
 * transient) follow, preserving chronology.
 */
export function mergeEvents(snapshot: RuntimeEvent[], overlay: RuntimeEvent[]): RuntimeEvent[] {
  const overlayById = new Map<number, RuntimeEvent>();
  for (const event of overlay) {
    if (event.id !== null) overlayById.set(event.id, event);
  }
  const merged: RuntimeEvent[] = [];
  const seenIds = new Set<number>();
  for (const event of snapshot) {
    if (event.id !== null) {
      merged.push(overlayById.get(event.id) ?? event);
      seenIds.add(event.id);
    } else {
      merged.push(event);
    }
  }
  for (const event of overlay) {
    if (event.id === null || !seenIds.has(event.id)) merged.push(event);
  }
  return merged;
}

export function mergeLiveSessionAggregates(
  snapshot: SessionAggregateSnapshot,
  overlayEvents: RuntimeEvent[],
  afterEventId: number,
): SessionAggregateSnapshot {
  let usage = snapshot.usage;
  let toolUsage = snapshot.toolUsage;
  let cost = snapshot.cost;
  let currentContextTokens = snapshot.currentContextTokens;
  let lastUsageEventId = afterEventId;

  for (const event of overlayEvents) {
    if (typeof event.id !== "number" || event.id <= afterEventId) continue;

    if (event.type === "session.usage") {
      usage = addUsageSummary(usage, event.payload);
      cost = addCostSummary(cost, event.payload, "model");
      if (event.id > lastUsageEventId) {
        currentContextTokens =
          readNumber(event.payload.inputTokens) + readNumber(event.payload.outputTokens);
        lastUsageEventId = event.id;
      }
      continue;
    }

    if (event.type === "session.tool_usage") {
      cost = addCostSummary(cost, event.payload, "tool");
      toolUsage = addToolUsageEvent(toolUsage, event.payload);
      continue;
    }

    if (event.type === "session.sandbox_usage") {
      cost = addCostSummary(cost, event.payload, "sandbox");
      continue;
    }

    if (event.type === "session.delegated_usage") {
      const eventUsage = isRecord(event.payload.usage) ? event.payload.usage : {};
      const eventCost = isRecord(event.payload.cost) ? event.payload.cost : {};
      const eventToolUsage = isRecord(event.payload.toolUsage) ? event.payload.toolUsage : {};
      usage = addUsageSummary(usage, eventUsage);
      cost = addCostRollup(cost, eventCost);
      toolUsage = addToolUsageRollup(toolUsage, eventToolUsage);
      if (event.id > lastUsageEventId) {
        currentContextTokens =
          readNumber(eventUsage.inputTokens) + readNumber(eventUsage.outputTokens);
        lastUsageEventId = event.id;
      }
    }
  }

  return { usage, toolUsage, cost, currentContextTokens };
}

export type RuntimeToolApprovalState = {
  status: "required" | "approved" | "denied";
  providerKey: string;
  permissionGroup?: "read" | "post" | "modify" | "admin" | undefined;
  decisionSource?: "user" | "timeout" | "abort" | undefined;
  requestedAt?: string | undefined;
};

export type RuntimeQuestionOption = {
  label: string;
  description?: string | undefined;
};

export type RuntimeQuestionItem = {
  header: string;
  question: string;
  options: RuntimeQuestionOption[];
  allowMultiple: boolean;
  allowOther: boolean;
};

export type RuntimeQuestionAnswer = {
  selectedLabels: string[];
  otherText?: string | undefined;
};

// State for an ask_user_question tool call. "pending" → render the interactive card; otherwise a
// read-only summary. `resolutionSource` mirrors the runner: user-answered, dismissed (user),
// superseded by a message, timed out, or aborted.
export type RuntimeQuestionState = {
  status: "pending" | "answered" | "cancelled";
  questions: RuntimeQuestionItem[];
  answers?: RuntimeQuestionAnswer[] | undefined;
  resolutionSource?: "user" | "abort" | "timeout" | "superseded" | undefined;
  requestedAt?: string | undefined;
};

export type RuntimeToolCall = {
  id: string;
  name: string;
  label?: string | undefined;
  status: "running" | "completed" | "failed";
  inputPreview: string;
  activityPreview: string;
  outputPreview: string;
  brainPath?: string | undefined;
  issueUrl?: string | undefined;
  approval?: RuntimeToolApprovalState | undefined;
  question?: RuntimeQuestionState | undefined;
  startedEventId: number | null;
  completedEventId: number | null;
};

export type AssistantTurnPart =
  | { type: "text"; text: string }
  | {
      type: "reasoning";
      text: string | undefined;
      durationSeconds?: number | undefined;
    }
  | { type: "tool-call"; toolCall: RuntimeToolCall };

export function applyRuntimeEventToState(
  state: SessionRuntimeState,
  event: RuntimeEvent,
): SessionRuntimeState {
  if (typeof event.id === "number" && state.events.some((item) => item.id === event.id)) {
    return state;
  }

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
        statusObserved: true,
        messages:
          status === "failed"
            ? stopRunningAssistantMessages(next.messages, next.events)
            : next.messages,
      };
    }
  }

  if (event.type === "session.error") {
    const message = readString(event.payload.message);
    next = {
      ...next,
      currentStatus: "failed",
      lastError: message || "The session failed.",
      statusObserved: true,
      messages: stopRunningAssistantMessages(next.messages, next.events),
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
    next = {
      ...next,
      cost: addCostSummary(next.cost, event.payload, "tool"),
      toolUsage: addToolUsageEvent(next.toolUsage, event.payload),
    };
  }

  if (event.type === "session.sandbox_usage") {
    next = {
      ...next,
      cost: addCostSummary(next.cost, event.payload, "sandbox"),
    };
  }

  if (event.type === "session.delegated_usage") {
    const usage = isRecord(event.payload.usage) ? event.payload.usage : {};
    const cost = isRecord(event.payload.cost) ? event.payload.cost : {};
    const toolUsage = isRecord(event.payload.toolUsage) ? event.payload.toolUsage : {};
    next = {
      ...next,
      usage: addUsageSummary(next.usage, usage),
      cost: addCostRollup(next.cost, cost),
      toolUsage: addToolUsageRollup(next.toolUsage, toolUsage),
    };
  }

  if (event.type === "message.created") {
    const messageId = readString(event.payload.messageId);
    const role = readString(event.payload.role);
    const internal = readBoolean(event.payload.internal);
    if (messageId && role && !next.messages.some((message) => message.id === messageId)) {
      const status =
        optionalString(event.payload.status) ?? (role === "user" ? "completed" : "running");
      next = {
        ...next,
        messages: [
          ...next.messages,
          {
            id: messageId,
            role,
            content: optionalString(event.payload.content) ?? "",
            status,
            internal,
            createdAt: event.createdAt ?? new Date().toISOString(),
          },
        ],
      };
    }
    if (role === "user" && !internal) {
      next = {
        ...next,
        currentStatus: "running",
        lastError: null,
        statusObserved: true,
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
      const completedAt = event.createdAt ?? new Date().toISOString();
      next = {
        ...next,
        messages: next.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                status: "completed",
                content: content ?? message.content,
                completedAt,
                thinkingDurationSeconds: computeThinkingDurationSeconds(
                  {
                    ...message,
                    completedAt,
                  },
                  next.events,
                ),
                ...(modelMessage ? { modelMessage } : {}),
              }
            : message,
        ),
      };
    }
  }

  return next;
}

function stopRunningAssistantMessages(messages: SessionMessage[], events: RuntimeEvent[]) {
  const completedAt = new Date().toISOString();
  return messages.map((message) =>
    message.role === "assistant" && message.status === "running"
      ? {
          ...message,
          status: "failed",
          completedAt: message.completedAt ?? completedAt,
          thinkingDurationSeconds:
            message.thinkingDurationSeconds ??
            computeThinkingDurationSeconds({ ...message, completedAt }, events),
        }
      : message,
  );
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
    sandboxCostUsdMicros: 0,
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
  kind: "model" | "tool" | "sandbox",
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
    sandboxCostUsdMicros:
      totals.sandboxCostUsdMicros + (kind === "sandbox" ? totalCostUsdMicros : 0),
  };
}

function addCostRollup(
  totals: SessionCostSummary,
  payload: Partial<Record<keyof SessionCostSummary, unknown>>,
): SessionCostSummary {
  const providerCostUsdMicros = readNumber(payload.providerCostUsdMicros);
  const platformFeeUsdMicros = readNumber(payload.platformFeeUsdMicros);
  const totalCostUsdMicros = readNumber(
    payload.totalCostUsdMicros ?? providerCostUsdMicros + platformFeeUsdMicros,
  );
  return {
    providerCostUsdMicros: totals.providerCostUsdMicros + providerCostUsdMicros,
    platformFeeUsdMicros: totals.platformFeeUsdMicros + platformFeeUsdMicros,
    totalCostUsdMicros: totals.totalCostUsdMicros + totalCostUsdMicros,
    modelCostUsdMicros: totals.modelCostUsdMicros + readNumber(payload.modelCostUsdMicros),
    toolCostUsdMicros: totals.toolCostUsdMicros + readNumber(payload.toolCostUsdMicros),
    sandboxCostUsdMicros: totals.sandboxCostUsdMicros + readNumber(payload.sandboxCostUsdMicros),
  };
}

function addToolUsageEvent(
  totals: SessionToolUsageSummary,
  payload: Record<string, unknown>,
): SessionToolUsageSummary {
  const provider = readString(payload.provider);
  const operation = readString(payload.operation);
  const costUsdMicros = readNumber(payload.costUsdMicros);
  if (!provider || !operation) return totals;

  const key = `${provider}:${operation}`;
  let matched = false;
  const byProviderOperation = totals.byProviderOperation.map((item) => {
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

  return {
    totalCostUsdMicros: totals.totalCostUsdMicros + costUsdMicros,
    byProviderOperation: byProviderOperation.sort((left, right) =>
      `${left.provider}:${left.operation}`.localeCompare(`${right.provider}:${right.operation}`),
    ),
  };
}

function addToolUsageRollup(
  totals: SessionToolUsageSummary,
  payload: Record<string, unknown>,
): SessionToolUsageSummary {
  const rows = Array.isArray(payload.byProviderOperation) ? payload.byProviderOperation : [];
  const byProviderOperation = new Map(
    totals.byProviderOperation.map((item) => [`${item.provider}:${item.operation}`, { ...item }]),
  );

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const provider = readString(row.provider);
    const operation = readString(row.operation);
    if (!provider || !operation) continue;
    const key = `${provider}:${operation}`;
    const current = byProviderOperation.get(key) ?? {
      provider,
      operation,
      costUsdMicros: 0,
      calls: 0,
    };
    current.costUsdMicros += readNumber(row.costUsdMicros);
    current.calls += readNumber(row.calls);
    byProviderOperation.set(key, current);
  }

  return {
    totalCostUsdMicros: totals.totalCostUsdMicros + readNumber(payload.totalCostUsdMicros),
    byProviderOperation: Array.from(byProviderOperation.values()).sort((left, right) =>
      `${left.provider}:${left.operation}`.localeCompare(`${right.provider}:${right.operation}`),
    ),
  };
}

// One consolidated entry per user / assistant / tool turn for the "Copy Debug JSON" export.
// The raw event stream carries every token and tool-argument delta, which is noise when you
// just want to read the conversation. Each message already holds its final content plus the
// verbatim `modelMessage` (the AI SDK ModelMessage — the structured turn with text, reasoning,
// and tool-call / tool-result parts), so we surface those directly and drop the deltas.
export type SessionDebugTurn = {
  id: string;
  role: string;
  status: string;
  internal?: boolean;
  toolName?: string | null;
  toolCallId?: string | null;
  createdAt?: string;
  completedAt?: string | null;
  // The verbatim model message, or null for a turn the runner never persisted one for (e.g. a
  // still-streaming assistant turn) — `content` is the fallback in that case.
  modelMessage: Record<string, unknown> | null;
  content: string;
};

export function buildSessionDebugTurns(messages: SessionMessage[]): SessionDebugTurn[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    status: message.status,
    ...(message.internal ? { internal: true } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    ...(message.completedAt ? { completedAt: message.completedAt } : {}),
    modelMessage: message.modelMessage ?? null,
    content: message.content,
  }));
}

export function isInspectableRuntimeEvent(event: RuntimeEvent) {
  return (
    event.type !== "message.delta" &&
    event.type !== "message.reasoning_delta" &&
    // Debug-only model-request snapshot — large and noisy; kept in detail.events for the
    // "Copy Debug JSON" export but hidden from the inspector's recent-events list.
    event.type !== "debug.model_request"
  );
}

// Reasoning is the model's current phase when the most recent event for a still-running
// message is a reasoning start/delta. Visible text, tool, usage, completion, or a durable
// reasoning completion flips this off; a later reasoning round flips it back on. Persisted
// `RuntimeEvent.id` values are monotonic; transient null-id events are ordered by arrival
// and win ties.
export function isReasoningInProgress(message: SessionMessage, events: RuntimeEvent[]): boolean {
  if (message.status !== "running") return false;
  let latest: RuntimeEvent | null = null;
  for (const event of events) {
    if (!eventBelongsToMessage(event, message.id)) continue;
    if (!latest || isEventAtLeastAsRecent(event, latest)) latest = event;
  }
  return latest?.type === "message.reasoning_started" || latest?.type === "message.reasoning_delta";
}

export function buildAssistantTurnParts(
  message: SessionMessage,
  events: RuntimeEvent[],
  messages: SessionMessage[] = [],
): AssistantTurnPart[] {
  const toolResultsByCallId = buildToolResultsByCallId(messages);
  const toolCalls = buildRuntimeToolCallsForMessage(events, message.id).map((toolCall) => {
    const outputPreview = toolCall.outputPreview || toolResultsByCallId.get(toolCall.id) || "";
    const issueUrl = toolCall.issueUrl ?? linearIssueUrlFromPayload(outputPreview);
    return {
      ...toolCall,
      status:
        toolCall.status === "failed"
          ? ("failed" as const)
          : outputPreview
            ? ("completed" as const)
            : toolCall.status,
      outputPreview,
      ...(issueUrl ? { issueUrl } : {}),
    };
  });
  const toolCallsById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const modelParts = readAssistantModelParts(message.modelMessage);
  const reasoningSummary = readReasoningSummary(events, message.id);
  const reasoningContent =
    readReasoningContent(events, message.id) || readModelReasoning(modelParts);
  const liveReasoning = readReasoningDeltas(events, message.id);
  const reasoningText = reasoningSummary || reasoningContent || liveReasoning || undefined;
  const thinkingDurationSeconds =
    message.thinkingDurationSeconds ?? computeThinkingDurationSeconds(message, events);
  const hasReasoningEvidence =
    Boolean(reasoningText) ||
    thinkingDurationSeconds !== undefined ||
    hasReasoningPhaseEvent(events, message.id) ||
    hasReasoningDelta(events, message.id);
  const reasoningParts: AssistantTurnPart[] = hasReasoningEvidence
    ? [
        {
          type: "reasoning",
          text: reasoningText,
          ...(thinkingDurationSeconds !== undefined
            ? { durationSeconds: thinkingDurationSeconds }
            : {}),
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
      const issueUrl =
        matchingToolCall?.issueUrl ??
        linearIssueUrlFromToolCallPart(part) ??
        linearIssueUrlFromPayload(toolResultsByCallId.get(toolCallId));
      const display = resolveToolDisplay(
        readString(part.toolName) || "Tool call",
        part.input ?? part.args,
      );
      const label = matchingToolCall?.label ?? display.label;

      turnParts.push({
        type: "tool-call",
        toolCall: {
          id: toolCallId,
          name: display.name,
          ...(label ? { label } : {}),
          status: matchingToolCall?.status ?? "completed",
          inputPreview: formatRuntimePreview(display.input) || matchingToolCall?.inputPreview || "",
          activityPreview: matchingToolCall?.activityPreview ?? "",
          outputPreview:
            matchingToolCall?.outputPreview || toolResultsByCallId.get(toolCallId) || "",
          ...(brainPath ? { brainPath } : {}),
          ...(issueUrl ? { issueUrl } : {}),
          ...(matchingToolCall?.approval ? { approval: matchingToolCall.approval } : {}),
          ...(matchingToolCall?.question ? { question: matchingToolCall.question } : {}),
          startedEventId: matchingToolCall?.startedEventId ?? null,
          completedEventId: matchingToolCall?.completedEventId ?? null,
        },
      });
    }

    return normalizeAssistantTurnParts(turnParts);
  }

  const eventParts = buildEventAssistantTurnParts(events, message.id, toolCallsById);
  if (eventParts.length > 0) return normalizeAssistantTurnParts([...reasoningParts, ...eventParts]);
  if (reasoningParts.length > 0 && message.content) {
    return [...reasoningParts, { type: "text", text: message.content }];
  }
  if (reasoningParts.length > 0) return reasoningParts;
  return message.content ? [{ type: "text", text: message.content }] : [];
}

// Assistant text streams in across model steps, which produces two artifacts: a chunk
// that begins with the previous sentence's closing punctuation ("…used" then
// ". Might take…"), and short utterances that can read as run-ons. Move leading
// continuation punctuation back onto the previous text part and drop parts left empty.
const LEADING_CONTINUATION_PUNCTUATION = /^\s*([.,;:!?)\]}'"]+)/;

function normalizeAssistantTurnParts(parts: AssistantTurnPart[]): AssistantTurnPart[] {
  const result: AssistantTurnPart[] = [];
  let lastTextIndex = -1;

  for (const part of parts) {
    if (part.type !== "text") {
      result.push(part);
      continue;
    }

    let text = part.text;
    if (lastTextIndex >= 0) {
      const match = text.match(LEADING_CONTINUATION_PUNCTUATION);
      const previous = result[lastTextIndex];
      if (match && previous?.type === "text") {
        result[lastTextIndex] = { ...previous, text: `${previous.text}${match[1]}` };
        text = text.slice(match[0].length);
      }
    }
    text = text.replace(/^\s+/, "");
    if (!text) continue;

    result.push({ type: "text", text });
    lastTextIndex = result.length - 1;
  }

  return result;
}

// The synthetic tool-call name for after-session/memory-pass lifecycle rows. The view keys
// memory-specific rendering (the collapsed summary line) off this name.
export const AFTER_SESSION_TOOL_NAME = "updating_memory";

// A background pass (memory keeper / after-session hook) surfaced as a transcript part.
// `anchorMessageId` is the user message whose turn the pass followed — the view uses it to
// interleave the card at its true chronological position instead of pinning it to the bottom.
export type BackgroundActivityEntry = {
  anchorMessageId: string | null;
  part: AssistantTurnPart;
};

export function buildBackgroundActivityParts(
  events: RuntimeEvent[],
  messages: SessionMessage[],
): BackgroundActivityEntry[] {
  const partsWithOrder: Array<{ order: number; entry: BackgroundActivityEntry }> = [];

  for (const { toolCall, anchorMessageId } of buildAfterSessionLifecycleToolCalls(events)) {
    partsWithOrder.push({
      order: toolCall.startedEventId ?? toolCall.completedEventId ?? Number.MAX_SAFE_INTEGER,
      entry: { anchorMessageId, part: { type: "tool-call", toolCall } },
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
        entry: { anchorMessageId: message.responseToMessageId ?? null, part },
      });
    }
  }

  return partsWithOrder.sort((left, right) => left.order - right.order).map((item) => item.entry);
}

function buildAfterSessionLifecycleToolCalls(events: RuntimeEvent[]) {
  const calls: Array<{ toolCall: RuntimeToolCall; anchorMessageId: string | null }> = [];
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
      name: AFTER_SESSION_TOOL_NAME,
      label: "Updating memory",
      status: "running",
      inputPreview: "",
      activityPreview: "",
      outputPreview: "",
      startedEventId: null,
      completedEventId: null,
    };
    calls.push({ toolCall: call, anchorMessageId: input.messageId || null });
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
    // The first event for a run may carry only the runId; backfill the turn anchor as soon
    // as any lifecycle event names the user message the pass followed.
    if (messageId) {
      const entry = calls.find((item) => item.toolCall === call);
      if (entry && !entry.anchorMessageId) entry.anchorMessageId = messageId;
    }
    if (event.type === "after_session.started") {
      call.status = "running";
      call.startedEventId = event.id ?? null;
    }
    if (event.type === "after_session.spawned") {
      call.status = "running";
      call.startedEventId = event.id ?? null;
    }
    if (event.type === "after_session.completed") {
      call.status = "completed";
      call.label = "Updated memory";
      // The memory pass forwards the keeper's one-line closing note as `summary` — what was
      // actually stored (or "Nothing new worth saving."). Fall back for events that predate it.
      const summary = readString(event.payload.summary);
      call.outputPreview = summary || "Memory updated";
      call.activityPreview = summary;
      call.completedEventId = event.id ?? null;
    }
    if (event.type === "after_session.failed") {
      call.status = "failed";
      call.outputPreview = readString(event.payload.message) || "Memory update failed.";
      call.completedEventId = event.id ?? null;
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
  return event?.id ?? undefined;
}

function eventOrderValue(event: RuntimeEvent) {
  return event.id ?? Number.MAX_SAFE_INTEGER;
}

function isEventAtLeastAsRecent(event: RuntimeEvent, latest: RuntimeEvent) {
  const order = eventOrderValue(event);
  const latestOrder = eventOrderValue(latest);
  if (order > latestOrder) return true;
  if (order < latestOrder) return false;
  return event.id === null;
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

    if (event.type === "tool.approval_required") {
      const call = getCall(toolCallId);
      // The approval event carries the structured input, so a use_tool envelope unwraps to its
      // inner tool name + dynamic label here — the card matches the later tool.started rendering.
      const display = resolveToolDisplay(
        readString(event.payload.name) || call.name,
        event.payload.input,
      );
      call.name = display.name || call.name;
      call.label = display.label ?? call.label;
      // Prefer the unwrapped inner arguments so a deferred use_tool approval card shows what the
      // user is actually approving, matching the tool.started rendering; fall back to the persisted
      // wrapper preview, then whatever the call already had.
      call.inputPreview =
        formatRuntimePreview(display.input) ||
        formatRuntimePreview(event.payload.inputPreview) ||
        call.inputPreview;
      call.approval = {
        status: "required",
        providerKey: readString(event.payload.providerKey),
        permissionGroup: readPermissionGroup(event.payload.permissionGroup),
        requestedAt: readString(event.payload.requestedAt) || undefined,
      };
    }

    if (event.type === "tool.approval_resolved") {
      const call = getCall(toolCallId);
      const decision = readString(event.payload.decision) === "approved" ? "approved" : "denied";
      const decisionSource = readString(event.payload.decisionSource);
      call.approval = {
        status: decision,
        providerKey: call.approval?.providerKey ?? "",
        permissionGroup: call.approval?.permissionGroup,
        requestedAt: call.approval?.requestedAt,
        decisionSource:
          decisionSource === "timeout" || decisionSource === "abort" ? decisionSource : "user",
      };
    }

    if (event.type === "question.requested") {
      const call = getCall(toolCallId);
      call.name = "ask_user_question";
      call.question = {
        status: "pending",
        questions: readQuestionPrompts(event.payload.questions),
        requestedAt: readString(event.payload.requestedAt) || undefined,
      };
    }

    if (event.type === "question.answered") {
      const call = getCall(toolCallId);
      call.name = "ask_user_question";
      const resolutionSource = readString(event.payload.resolutionSource);
      // Prefer the explicit `answered` flag the runner now emits. Fall back to inferring from the
      // resolution source for events written before that field existed — note that a user X-dismiss
      // is (cancelled, user), which the old inference wrongly rendered as an answer.
      const answered =
        event.payload.answered === undefined
          ? resolutionSource === "user" || resolutionSource === ""
          : readBoolean(event.payload.answered);
      call.question = {
        status: answered ? "answered" : "cancelled",
        questions: call.question?.questions ?? [],
        answers: readQuestionAnswers(event.payload.answers),
        resolutionSource:
          resolutionSource === "abort" ||
          resolutionSource === "timeout" ||
          resolutionSource === "superseded"
            ? resolutionSource
            : "user",
        requestedAt: call.question?.requestedAt,
      };
    }

    if (event.type === "tool.started") {
      const call = getCall(toolCallId);
      const display = resolveToolDisplay(
        readString(event.payload.name) || call.name,
        event.payload.input,
      );
      call.name = display.name || call.name;
      call.label = display.label ?? call.label;
      call.inputPreview = formatRuntimePreview(display.input) || call.inputPreview;
      if (call.approval?.status === "required") {
        call.approval = {
          ...call.approval,
          status: "approved",
          decisionSource: "user",
        };
      }
      const brainPath = brainPathForToolPayload(call.name, display.input);
      if (brainPath) {
        call.brainPath = brainPath;
      }
      const issueUrl = linearIssueUrlFromPayload(event.payload.input);
      if (issueUrl) {
        call.issueUrl = issueUrl;
      }
      call.startedEventId = event.id ?? null;
    }

    if (event.type === "tool.completed" || event.type === "tool.failed") {
      const call = getCall(toolCallId);
      // Completion events carry no input to unwrap, so keep the inner name resolved at tool.started
      // rather than letting the raw use_tool envelope name overwrite it.
      const rawName = readString(event.payload.name);
      if (rawName && rawName !== BUILTIN_USE_TOOL_NAME) call.name = rawName;
      call.status = event.type === "tool.failed" ? "failed" : "completed";
      call.outputPreview =
        event.type === "tool.failed"
          ? formatRuntimePreview(
              event.payload.outputPreview || event.payload.error || event.payload.output,
            )
          : formatRuntimePreview(event.payload.outputPreview || event.payload.output);
      const brainPath = brainPathForToolPayload(call.name, event.payload.output);
      if (brainPath) {
        call.brainPath = brainPath;
      }
      // Output carries the canonical issue URL, so let it win over any input-derived value.
      const issueUrl =
        linearIssueUrlFromPayload(event.payload.output) ||
        linearIssueUrlFromPayload(event.payload.outputPreview);
      if (issueUrl) {
        call.issueUrl = issueUrl;
      }
      call.completedEventId = event.id ?? null;
    }
  }

  const latestSessionError = latestSessionErrorAfter(events, messageId);
  if (latestSessionError) {
    const latestRunningCall = [...calls]
      .reverse()
      .find(
        (call) =>
          call.status === "running" &&
          (call.startedEventId ?? 0) < (latestSessionError.id ?? Number.MAX_SAFE_INTEGER),
      );
    if (latestRunningCall) {
      latestRunningCall.status = "failed";
      latestRunningCall.outputPreview =
        formatRuntimePreview({ message: readString(latestSessionError.payload.message) }) ||
        "The session failed before this tool returned a result.";
      latestRunningCall.completedEventId = latestSessionError.id ?? null;
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

    // A model step ends with a usage event. Treat it as an utterance boundary so the
    // streaming view splits per-step text into separate blocks, matching the final
    // (modelMessage-based) view instead of merging two utterances into one paragraph.
    if (event.type === "session.usage") {
      flushText();
      continue;
    }

    if (
      event.type === "tool.delta" ||
      event.type === "tool.approval_required" ||
      event.type === "tool.approval_resolved" ||
      event.type === "question.requested" ||
      event.type === "question.answered" ||
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
      latestToolEventId = Math.max(latestToolEventId, event.id ?? 0);
    }
  }

  let latestError: RuntimeEvent | null = null;
  for (const event of events) {
    if (event.type === "session.error" && (event.id ?? 0) > latestToolEventId) {
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
  if ((name !== "write_file" && name !== "edit_file") || !isRecord(payload)) return undefined;
  return normalizeBrainWorkspacePath(payload.path);
}

function normalizeBrainWorkspacePath(value: unknown) {
  if (typeof value !== "string") return undefined;
  const path = value.trim().replace(/^\.?\//, "");
  if (!path.startsWith("brain/")) return undefined;
  const brainPath = path.slice("brain/".length);
  return brainPath || undefined;
}

// Linear surfaces the canonical issue URL in tool output (and sometimes input). Pull it so the
// transcript can link straight out to the issue, mirroring how brainPath drives the brain badge.
const LINEAR_ISSUE_URL_RE =
  /https?:\/\/linear\.app\/[^\s"'<>)\]]+\/issue\/[A-Za-z0-9]+-\d+[^\s"'<>)\]]*/;

function safeStringifyForUrlScan(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function linearIssueUrlFromPayload(payload: unknown): string | undefined {
  const text = safeStringifyForUrlScan(payload);
  if (!text) return undefined;
  return text.match(LINEAR_ISSUE_URL_RE)?.[0];
}

function linearIssueUrlFromToolCallPart(part: Record<string, unknown>) {
  return (
    linearIssueUrlFromPayload(part.output) ||
    linearIssueUrlFromPayload(part.input) ||
    linearIssueUrlFromPayload(part.args) ||
    undefined
  );
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

function readPermissionGroup(value: unknown): "read" | "post" | "modify" | "admin" | undefined {
  return value === "read" || value === "post" || value === "modify" || value === "admin"
    ? value
    : undefined;
}

function readQuestionPrompts(value: unknown): RuntimeQuestionItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const record = raw as Record<string, unknown>;
    const question = readString(record.question);
    if (!question) return [];
    const options = Array.isArray(record.options)
      ? record.options.flatMap((rawOption) => {
          if (!rawOption || typeof rawOption !== "object") return [];
          const optionRecord = rawOption as Record<string, unknown>;
          const label = readString(optionRecord.label);
          if (!label) return [];
          const description = readString(optionRecord.description);
          return [description ? { label, description } : { label }];
        })
      : [];
    return [
      {
        header: readString(record.header) || question,
        question,
        options,
        allowMultiple: record.allowMultiple === true,
        allowOther: record.allowOther === true,
      },
    ];
  });
}

function readQuestionAnswers(value: unknown): RuntimeQuestionAnswer[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const selectedLabels = Array.isArray(record.selectedLabels)
      ? record.selectedLabels.filter((label): label is string => typeof label === "string")
      : [];
    const otherText = readString(record.otherText);
    return otherText ? { selectedLabels, otherText } : { selectedLabels };
  });
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

function readReasoningContent(events: RuntimeEvent[], messageId: string) {
  return events
    .filter((event) => event.type === "message.reasoning_content")
    .filter((event) => eventBelongsToMessage(event, messageId))
    .filter((event) => readString(event.payload.format) === "raw")
    .map((event) => readString(event.payload.text).trim())
    .filter(Boolean)
    .join("\n\n");
}

function readModelReasoning(parts: Record<string, unknown>[] | null) {
  if (!parts) return "";
  return parts
    .filter((part) => part.type === "reasoning")
    .map((part) => readString(part.text).trim())
    .filter(Boolean)
    .join("\n\n");
}

function readReasoningDeltas(events: RuntimeEvent[], messageId: string) {
  return events
    .filter((event) => event.type === "message.reasoning_delta")
    .filter((event) => eventBelongsToMessage(event, messageId))
    .map((event) => readString(event.payload.delta))
    .filter(Boolean)
    .join("");
}

function hasReasoningDelta(events: RuntimeEvent[], messageId: string) {
  return events.some(
    (event) => event.type === "message.reasoning_delta" && eventBelongsToMessage(event, messageId),
  );
}

function hasReasoningPhaseEvent(events: RuntimeEvent[], messageId: string) {
  return events.some(
    (event) =>
      (event.type === "message.reasoning_started" ||
        event.type === "message.reasoning_completed") &&
      eventBelongsToMessage(event, messageId),
  );
}

function readReasoningWindowDurationSeconds(message: SessionMessage, events: RuntimeEvent[]) {
  let durationMs = 0;
  let reasoningStartedAt: number | null = null;
  let reasoningStartedBy: "durable" | "transient" | null = null;

  for (const event of events) {
    if (!eventBelongsToMessage(event, message.id)) continue;

    const eventAt = readTimestamp(event.createdAt);
    if (!eventAt) continue;

    if (event.type === "message.reasoning_started") {
      reasoningStartedAt ??= eventAt;
      reasoningStartedBy ??= "durable";
      continue;
    }

    if (event.type === "message.reasoning_delta") {
      reasoningStartedAt ??= eventAt;
      reasoningStartedBy ??= "transient";
      continue;
    }

    if (
      reasoningStartedAt !== null &&
      (event.type === "message.reasoning_completed" || reasoningStartedBy === "transient")
    ) {
      if (eventAt > reasoningStartedAt) durationMs += eventAt - reasoningStartedAt;
      reasoningStartedAt = null;
      reasoningStartedBy = null;
    }
  }

  if (reasoningStartedAt !== null) {
    const completedAt = readTimestamp(message.completedAt);
    if (completedAt && completedAt > reasoningStartedAt) {
      durationMs += completedAt - reasoningStartedAt;
    }
  }

  if (durationMs <= 0) return undefined;
  return Math.max(Math.round(durationMs / 1000), 1);
}

export function computeThinkingDurationSeconds(
  message: SessionMessage,
  events: RuntimeEvent[],
): number | undefined {
  return readReasoningWindowDurationSeconds(message, events);
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

// Translate a raw tool name + input into a human one-liner ("Searching the web for …").
// The raw tool name stays available on hover and in the expanded Input section.
export function describeToolCall(name: string, input: unknown): string | undefined {
  const record = isRecord(input) ? input : {};
  const field = (key: string) => readString(record[key]).trim();

  switch (name) {
    case "exa_search":
    case "exa_answer": {
      const query = field("query");
      return query ? `Searching the web for “${truncateLabelText(query)}”` : "Searching the web";
    }
    case "exa_contents":
      return "Reading web sources";
    case "x_search_posts": {
      const query = field("query");
      return query ? `Searching X for “${truncateLabelText(query)}”` : "Searching X";
    }
    case "youtube_search": {
      const query = field("query");
      return query ? `Searching YouTube for “${truncateLabelText(query)}”` : "Searching YouTube";
    }
    case "tiktok_search": {
      const query = field("query");
      return query ? `Searching TikTok for “${truncateLabelText(query)}”` : "Searching TikTok";
    }
    case "instagram_search_profiles": {
      const query = field("query");
      return query
        ? `Searching Instagram for “${truncateLabelText(query)}”`
        : "Searching Instagram";
    }
    case "web_fetch": {
      const host = hostFromUrl(field("url"));
      return host ? `Fetching ${host}` : "Fetching a web page";
    }
    case "read_file": {
      const path = field("path");
      return path ? `Reading ${path}` : "Reading a file";
    }
    case "list_files": {
      const path = field("path");
      return path ? `Listing ${path}` : "Listing files";
    }
    case "write_file": {
      const path = field("path");
      return path ? `Writing ${path}` : "Writing a file";
    }
    case "edit_file": {
      const path = field("path");
      return path ? `Editing ${path}` : "Editing a file";
    }
    case "git_diff":
      return "Reviewing changes";
    case "shell": {
      const command = field("command");
      return command ? `Running ${truncateLabelText(command)}` : "Running a command";
    }
    case "amp_coder":
      return "Coding with Amp";
    case "read_skill": {
      const skillId = field("skillId");
      return skillId ? `Reading ${skillId} skill` : "Reading a skill";
    }
    case "tool_help":
      return "Checking tool help";
    case "delegate_to_agent": {
      const agent = field("agent");
      return agent ? `Delegating to ${agent}` : "Delegating to an agent";
    }
    case "update_agent_file":
      return "Updating its agent configuration";
    case "memory":
      return describeMemoryToolCall(field("args"));
    default:
      return undefined;
  }
}

function describeMemoryToolCall(args: string) {
  const argv = parseGitHubCliArgs(args);
  if (!argv || argv.length === 0) return "Using memory";

  const command = argv[0];
  switch (command) {
    case "query": {
      const query = findMemoryPositionalArg(argv, 1);
      return query ? `Looking in memory for “${truncateLabelText(query)}”` : "Looking in memory";
    }
    case "get": {
      const id = findMemoryPositionalArg(argv, 1);
      return id ? `Reading memory for ${truncateLabelText(id)}` : "Reading memory";
    }
    case "create": {
      const id = firstCliOptionValue(argv, "--id");
      const type = firstCliOptionValue(argv, "--type");
      if (id) return `Saving ${truncateLabelText(id)} to memory`;
      return type ? `Creating a ${truncateLabelText(type)} memory` : "Saving to memory";
    }
    case "append-evidence": {
      const subject = firstCliOptionValue(argv, "--subject");
      const id = firstCliOptionValue(argv, "--id");
      if (subject) return `Saving evidence to memory for ${truncateLabelText(subject)}`;
      return id
        ? `Saving evidence ${truncateLabelText(id)} to memory`
        : "Saving evidence to memory";
    }
    case "rewrite": {
      const id = findMemoryPositionalArg(argv, 1);
      return id ? `Updating memory for ${truncateLabelText(id)}` : "Updating memory";
    }
    case "alias": {
      const id = findMemoryPositionalArg(argv, 1);
      return id
        ? `Updating memory aliases for ${truncateLabelText(id)}`
        : "Updating memory aliases";
    }
    case "link": {
      const id = findMemoryPositionalArg(argv, 1);
      const target = firstCliOptionValue(argv, "--to");
      if (id && target) {
        return `Linking ${truncateLabelText(id)} to ${truncateLabelText(target)} in memory`;
      }
      return id ? `Linking memory records for ${truncateLabelText(id)}` : "Linking memory records";
    }
    case "merge": {
      const from = firstCliOptionValue(argv, "--from");
      const into = firstCliOptionValue(argv, "--into");
      if (from && into) {
        return `Merging ${truncateLabelText(from)} into ${truncateLabelText(into)} in memory`;
      }
      return "Merging memory records";
    }
    case "delete": {
      const id = findMemoryPositionalArg(argv, 1);
      return id ? `Deleting ${truncateLabelText(id)} from memory` : "Deleting from memory";
    }
    case "doctor":
      return "Checking memory consistency";
    case "help":
      return "Opening memory help";
    default:
      return "Using memory";
  }
}

const MEMORY_CLI_VALUE_OPTIONS = new Set([
  "--add",
  "--alias",
  "--as",
  "--captured-at",
  "--folder",
  "--from",
  "--hops",
  "--id",
  "--into",
  "--kind",
  "--limit",
  "--remove",
  "--root",
  "--section",
  "--since",
  "--source-ref",
  "--status",
  "--subject",
  "--summary",
  "--to",
  "--truth",
  "--type",
]);

function findMemoryPositionalArg(argv: string[], startIndex: number) {
  for (let index = startIndex; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (!arg) continue;
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && MEMORY_CLI_VALUE_OPTIONS.has(arg)) index += 1;
      continue;
    }
    return arg;
  }
  return "";
}

function firstCliOptionValue(argv: string[], option: string) {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === option) {
      const value = argv[index + 1] ?? "";
      return value.startsWith("--") ? "" : value;
    }
    if (arg.startsWith(`${option}=`)) {
      return arg.slice(option.length + 1);
    }
  }
  return "";
}

// Resolve the user-facing name + label for a (possibly use_tool-wrapped) call. `name` is the inner
// tool's programmatic identifier (the dispatcher envelope is transparent here), `input` is its
// unwrapped arguments, and `label` is the richest phrasing available: a dynamic one-liner when we
// have one, otherwise the registry's static title. Never returns the raw `use_tool` wrapper.
export function resolveToolDisplay(
  rawName: string,
  rawInput: unknown,
): { name: string; input: unknown; label: string | undefined } {
  const { name, input } = effectiveToolCall(rawName, rawInput);
  const label = describeToolCall(name, input) ?? toolDisplayTitle(name);
  return { name, input, label };
}

function truncateLabelText(value: string) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  const maxLength = 80;
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function hostFromUrl(url: string) {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
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
