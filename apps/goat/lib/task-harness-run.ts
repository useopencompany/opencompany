import { getAgentModelDefinition } from "@opencompany/agent-runtime";
import type {
  GoatTaskEvent,
  GoatTaskEventType,
  GoatTaskMessage,
  GoatTaskMessageRole,
  GoatTaskMessageStatus,
  GoatTaskModelUsage,
  GoatTaskModelUsagePhase,
  GoatTaskSandboxUsage,
  GoatTaskStage,
  GoatTaskStatus,
  GoatTaskToolName,
  GoatTaskToolUsage,
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

export type GoatTaskRunModelUsageInput =
  | GoatTaskModelUsage
  | {
      id: number;
      task_id: string;
      user_workos_id: string;
      message_id: string | null;
      run_lease_id: string | null;
      phase: string;
      step_index: number;
      model_provider: string;
      model_name: string;
      response_id: string | null;
      response_model_id: string | null;
      finish_reason: string | null;
      raw_finish_reason: string | null;
      input_tokens: UsageNumberInput;
      input_no_cache_tokens: UsageNumberInput;
      input_cache_read_tokens: UsageNumberInput;
      input_cache_write_tokens: UsageNumberInput;
      output_tokens: UsageNumberInput;
      output_text_tokens: UsageNumberInput;
      output_reasoning_tokens: UsageNumberInput;
      total_tokens: UsageNumberInput;
      raw_usage: Record<string, unknown>;
      provider_created_at: string | null;
      provider_cost_usd_micros: UsageNumberInput;
      platform_fee_usd_micros: UsageNumberInput;
      total_cost_usd_micros: UsageNumberInput;
      cost_basis: Record<string, unknown>;
      created_at: string;
    };

export type GoatTaskRunToolUsageInput =
  | GoatTaskToolUsage
  | {
      id: number;
      task_id: string;
      user_workos_id: string;
      message_id: string | null;
      run_lease_id: string | null;
      tool_call_id: string;
      tool_name: string;
      provider: string;
      operation: string;
      provider_request_id: string | null;
      provider_cost_usd_micros: UsageNumberInput;
      platform_fee_usd_micros: UsageNumberInput;
      total_cost_usd_micros: UsageNumberInput;
      raw_usage: Record<string, unknown>;
      cost_basis: Record<string, unknown>;
      created_at: string;
    };

export type GoatTaskRunSandboxUsageInput =
  | GoatTaskSandboxUsage
  | {
      id: number;
      task_id: string;
      user_workos_id: string;
      message_id: string | null;
      run_lease_id: string | null;
      sandbox_id: string;
      template: string | null;
      vcpu: number | null;
      ram_mib: number | null;
      started_at: string | null;
      ended_at: string | null;
      active_ms: UsageNumberInput;
      provider_cost_usd_micros: UsageNumberInput;
      platform_fee_usd_micros: UsageNumberInput;
      total_cost_usd_micros: UsageNumberInput;
      raw_metrics: Record<string, unknown>;
      cost_basis: Record<string, unknown>;
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
  artifacts: GoatRunArtifact[];
  resultArtifact: GoatRunArtifact | null;
  events: GoatRunEvent[];
  models: GoatRunModelSummary[];
  cost: GoatRunCostSummary;
};

export type GoatRunArtifact = {
  type: "brain_markdown_report";
  title: string;
  url: string;
  brainPath: string;
  documentId: string;
  brainId: string;
  folderPath: string;
  mimeType: string;
  createdAt: string;
};

export type GoatRunModelSummary = {
  id: string;
  label: string;
  usageCount: number;
  phases: GoatTaskModelUsagePhase[];
};

export type GoatRunCostSummary = {
  hasRecordedCosts: boolean;
  totalCostUsdMicros: number;
  modelCostUsdMicros: number;
  toolCostUsdMicros: number;
  sandboxCostUsdMicros: number;
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  tokens: GoatRunTokenSummary;
  toolUsageByProviderOperation: GoatRunToolUsageSummary[];
};

export type GoatRunTokenSummary = {
  inputTokens: number;
  inputNoCacheTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
  outputTextTokens: number;
  outputReasoningTokens: number;
  totalTokens: number;
};

export type GoatRunToolUsageSummary = {
  provider: string;
  operation: string;
  costUsdMicros: number;
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  calls: number;
};

type UsageNumberInput = number | string;

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
  modelUsage?: readonly GoatTaskRunModelUsageInput[];
  toolUsage?: readonly GoatTaskRunToolUsageInput[];
  sandboxUsage?: readonly GoatTaskRunSandboxUsageInput[];
  cost?: GoatRunCostSummary;
}): GoatHarnessRunViewModel {
  const task = normalizeTask(input.task);
  const messages = input.messages.map(normalizeMessage).toSorted(compareCreatedAt);
  const events = input.events.map(normalizeEvent).toSorted((a, b) => a.id - b.id);
  const userMessage = messages.find((message) => message.role === "user") ?? null;
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const toolCalls = buildToolCalls(events);
  const artifacts = buildArtifacts(events);
  const models = buildModelSummary(task.model, input.modelUsage ?? []);

  return {
    hasDurableRun: messages.length > 0 || events.length > 0,
    legacyDetailText: "Detailed run events are available for new tasks only.",
    task,
    userMessage,
    assistantMessages,
    toolCalls,
    artifacts,
    resultArtifact: artifacts.at(-1) ?? null,
    events,
    models,
    cost:
      input.cost ??
      buildCostSummary({
        modelUsage: input.modelUsage ?? [],
        toolUsage: input.toolUsage ?? [],
        sandboxUsage: input.sandboxUsage ?? [],
      }),
  };
}

function buildModelSummary(
  fallbackModel: string,
  modelUsage: readonly GoatTaskRunModelUsageInput[],
): GoatRunModelSummary[] {
  const byModel = new Map<
    string,
    { id: string; usageCount: number; phases: Set<GoatTaskModelUsagePhase> }
  >();

  for (const usage of modelUsage) {
    const modelId = readUsageString(usage, "modelName", "model_name") || fallbackModel;
    const phase = readModelUsagePhase(usage);
    const current = byModel.get(modelId) ?? { id: modelId, usageCount: 0, phases: new Set() };
    current.usageCount += 1;
    if (phase) current.phases.add(phase);
    byModel.set(modelId, current);
  }

  if (byModel.size === 0) {
    byModel.set(fallbackModel, { id: fallbackModel, usageCount: 0, phases: new Set() });
  }

  return Array.from(byModel.values()).map((model) => ({
    id: model.id,
    label: modelLabel(model.id),
    usageCount: model.usageCount,
    phases: Array.from(model.phases),
  }));
}

function modelLabel(modelId: string) {
  return getAgentModelDefinition(modelId)?.label ?? modelId;
}

function buildCostSummary(input: {
  modelUsage: readonly GoatTaskRunModelUsageInput[];
  toolUsage: readonly GoatTaskRunToolUsageInput[];
  sandboxUsage: readonly GoatTaskRunSandboxUsageInput[];
}): GoatRunCostSummary {
  const tokens = emptyTokenSummary();
  let modelCostUsdMicros = 0;
  let modelProviderCostUsdMicros = 0;
  let modelPlatformFeeUsdMicros = 0;

  for (const usage of input.modelUsage) {
    modelCostUsdMicros += readUsageNumber(usage, "totalCostUsdMicros", "total_cost_usd_micros");
    modelProviderCostUsdMicros += readUsageNumber(
      usage,
      "providerCostUsdMicros",
      "provider_cost_usd_micros",
    );
    modelPlatformFeeUsdMicros += readUsageNumber(
      usage,
      "platformFeeUsdMicros",
      "platform_fee_usd_micros",
    );
    tokens.inputTokens += readUsageNumber(usage, "inputTokens", "input_tokens");
    tokens.inputNoCacheTokens += readUsageNumber(
      usage,
      "inputNoCacheTokens",
      "input_no_cache_tokens",
    );
    tokens.inputCacheReadTokens += readUsageNumber(
      usage,
      "inputCacheReadTokens",
      "input_cache_read_tokens",
    );
    tokens.inputCacheWriteTokens += readUsageNumber(
      usage,
      "inputCacheWriteTokens",
      "input_cache_write_tokens",
    );
    tokens.outputTokens += readUsageNumber(usage, "outputTokens", "output_tokens");
    tokens.outputTextTokens += readUsageNumber(usage, "outputTextTokens", "output_text_tokens");
    tokens.outputReasoningTokens += readUsageNumber(
      usage,
      "outputReasoningTokens",
      "output_reasoning_tokens",
    );
    tokens.totalTokens += readUsageNumber(usage, "totalTokens", "total_tokens");
  }

  let toolCostUsdMicros = 0;
  let toolProviderCostUsdMicros = 0;
  let toolPlatformFeeUsdMicros = 0;
  const toolGroups = new Map<string, GoatRunToolUsageSummary>();
  for (const usage of input.toolUsage) {
    const provider = readUsageString(usage, "provider", "provider") || "unknown";
    const operation = readUsageString(usage, "operation", "operation") || "unknown";
    const totalCost = readUsageNumber(usage, "totalCostUsdMicros", "total_cost_usd_micros");
    const providerCost = readUsageNumber(
      usage,
      "providerCostUsdMicros",
      "provider_cost_usd_micros",
    );
    const platformFee = readUsageNumber(usage, "platformFeeUsdMicros", "platform_fee_usd_micros");
    toolCostUsdMicros += totalCost;
    toolProviderCostUsdMicros += providerCost;
    toolPlatformFeeUsdMicros += platformFee;
    const key = `${provider}\u0000${operation}`;
    const current = toolGroups.get(key) ?? makeToolUsageSummary(provider, operation);
    current.costUsdMicros += totalCost;
    current.providerCostUsdMicros += providerCost;
    current.platformFeeUsdMicros += platformFee;
    current.calls += 1;
    toolGroups.set(key, current);
  }

  let sandboxCostUsdMicros = 0;
  let sandboxProviderCostUsdMicros = 0;
  let sandboxPlatformFeeUsdMicros = 0;
  for (const usage of input.sandboxUsage) {
    sandboxCostUsdMicros += readUsageNumber(usage, "totalCostUsdMicros", "total_cost_usd_micros");
    sandboxProviderCostUsdMicros += readUsageNumber(
      usage,
      "providerCostUsdMicros",
      "provider_cost_usd_micros",
    );
    sandboxPlatformFeeUsdMicros += readUsageNumber(
      usage,
      "platformFeeUsdMicros",
      "platform_fee_usd_micros",
    );
  }

  return {
    hasRecordedCosts:
      input.modelUsage.length > 0 || input.toolUsage.length > 0 || input.sandboxUsage.length > 0,
    totalCostUsdMicros: modelCostUsdMicros + toolCostUsdMicros + sandboxCostUsdMicros,
    modelCostUsdMicros,
    toolCostUsdMicros,
    sandboxCostUsdMicros,
    providerCostUsdMicros:
      modelProviderCostUsdMicros + toolProviderCostUsdMicros + sandboxProviderCostUsdMicros,
    platformFeeUsdMicros:
      modelPlatformFeeUsdMicros + toolPlatformFeeUsdMicros + sandboxPlatformFeeUsdMicros,
    tokens,
    toolUsageByProviderOperation: Array.from(toolGroups.values()).toSorted((a, b) => {
      const provider = a.provider.localeCompare(b.provider);
      return provider === 0 ? a.operation.localeCompare(b.operation) : provider;
    }),
  };
}

function emptyTokenSummary(): GoatRunTokenSummary {
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

function makeToolUsageSummary(provider: string, operation: string): GoatRunToolUsageSummary {
  return {
    provider,
    operation,
    costUsdMicros: 0,
    providerCostUsdMicros: 0,
    platformFeeUsdMicros: 0,
    calls: 0,
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

function buildArtifacts(events: readonly GoatRunEvent[]): GoatRunArtifact[] {
  return events
    .flatMap((event): GoatRunArtifact[] => {
      if (event.type !== "artifact.created") return [];
      const artifact = parseArtifact(event.payload.artifact);
      return artifact ? [{ ...artifact, createdAt: event.createdAt }] : [];
    })
    .toSorted(compareCreatedAt);
}

function parseArtifact(value: unknown): Omit<GoatRunArtifact, "createdAt"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "brain_markdown_report") return null;
  const title = readString(record.title).trim();
  const url = readString(record.url).trim();
  const brainPath = readString(record.brainPath).trim();
  const documentId = readString(record.documentId).trim();
  const brainId = readString(record.brainId).trim();
  const folderPath = readString(record.folderPath).trim();
  const mimeType = readString(record.mimeType).trim() || "text/markdown";
  if (!title || !isInternalBrainUrl(url) || !brainPath || !documentId || !brainId || !folderPath) {
    return null;
  }
  return {
    type: "brain_markdown_report",
    title,
    url,
    brainPath,
    documentId,
    brainId,
    folderPath,
    mimeType,
  };
}

function isInternalBrainUrl(url: string) {
  return url.startsWith("/brain/") && !url.startsWith("//");
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

function readUsageNumber(value: unknown, camelKey: string, snakeKey: string) {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const raw = record[camelKey] ?? record[snakeKey];
  const valueNumber =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;
  return Number.isFinite(valueNumber) ? Math.max(0, Math.trunc(valueNumber)) : 0;
}

function readUsageString(value: unknown, camelKey: string, snakeKey: string) {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const raw = record[camelKey] ?? record[snakeKey];
  return typeof raw === "string" ? raw.trim() : "";
}

function readModelUsagePhase(value: unknown): GoatTaskModelUsagePhase | null {
  const phase = readUsageString(value, "phase", "phase");
  return phase === "planner" || phase === "execution" ? phase : null;
}
