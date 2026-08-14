export const BRAIN_INGEST_TRACE_SCHEMA_VERSION = "goat.brain_ingest_trace.v1";

export const BRAIN_INGEST_TRACE_MAX_TOOL_CALLS = 96;
export const BRAIN_INGEST_TRACE_MAX_ARGS = 80;
export const BRAIN_INGEST_TRACE_ARG_PREVIEW_LENGTH = 240;
export const BRAIN_INGEST_TRACE_STDIN_PREVIEW_LENGTH = 1_200;
export const BRAIN_INGEST_TRACE_OUTPUT_PREVIEW_LENGTH = 2_000;
export const BRAIN_INGEST_TRACE_FINAL_TEXT_LENGTH = 2_000;
export const BRAIN_INGEST_TRIAGE_REASON_LENGTH = 500;
export const BRAIN_INGEST_TRIAGE_MAX_ENTITY_HINTS = 12;
export const BRAIN_INGEST_TRIAGE_ENTITY_HINT_LENGTH = 160;

export type BrainIngestTraceUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  // Anthropic prompt-cache detail (reads bill ~0.1x, writes ~1.25x input).
  // inputTokens already includes both. Optional so pre-cache traces normalize
  // cleanly; null when the gateway did not report cache detail.
  cacheReadInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
};

export type BrainIngestBudget = {
  limitUsdMicros: number;
  stopThresholdUsdMicros: number;
  modelCostUsdMicros: number;
  brainQueryCostUsdMicros: number;
  webSearchCostUsdMicros: number;
  totalCostUsdMicros: number;
  accountingComplete: boolean;
  exhausted: boolean;
};

export type BrainIngestTriageTrace = {
  model: string;
  decision: "skip" | "ingest";
  reason: string;
  entityHints: string[];
  usage: BrainIngestTraceUsage;
  modelCostUsdMicros: number;
};

export type BrainIngestTraceToolCallStatus = "completed" | "failed" | "blocked";

export type BrainIngestTraceToolCall = {
  id: string;
  toolName: "goat_brain";
  command: string;
  args: string[];
  stdinPreview: string | null;
  status: BrainIngestTraceToolCallStatus;
  mutating: boolean;
  exitCode: number | null;
  stdoutPreview: string;
  stderrPreview: string;
  errorPreview: string;
  startedAt: string;
  completedAt: string;
};

export type BrainIngestTrace = {
  schemaVersion: typeof BRAIN_INGEST_TRACE_SCHEMA_VERSION;
  model: string;
  steps: number;
  toolCallCount: number;
  mutations: number;
  usage: BrainIngestTraceUsage;
  finalText: string;
  toolCalls: BrainIngestTraceToolCall[];
  truncatedToolCalls: number;
  // Web-search enrichment usage for this ingest (0 when enrichment is disabled,
  // unavailable, or unused). Optional so existing v1 traces normalize cleanly.
  webSearchCount?: number;
  webSearchCostUsdMicros?: number;
  // A source-only tiny-model pass that ran before any Brain materialization.
  // Optional so pre-triage v1 traces continue to normalize cleanly.
  triage?: BrainIngestTriageTrace;
  // Provider spend accumulated at step boundaries for the current worker
  // attempt. Optional so pre-budget traces continue to normalize.
  budget?: BrainIngestBudget;
  createdAt: string;
};

export function normalizeBrainIngestTrace(value: unknown): BrainIngestTrace | null {
  const record = readRecord(value);
  if (!record || record.schemaVersion !== BRAIN_INGEST_TRACE_SCHEMA_VERSION) return null;

  const toolCalls = readArray(record.toolCalls)
    .slice(0, BRAIN_INGEST_TRACE_MAX_TOOL_CALLS)
    .flatMap((item): BrainIngestTraceToolCall[] => {
      const toolCall = normalizeTraceToolCall(item);
      return toolCall ? [toolCall] : [];
    });
  const budget = normalizeBudget(record.budget);
  const triage = normalizeTriageTrace(record.triage);

  return {
    schemaVersion: BRAIN_INGEST_TRACE_SCHEMA_VERSION,
    model: readString(record.model),
    steps: readNonNegativeInteger(record.steps),
    toolCallCount: readNonNegativeInteger(record.toolCallCount),
    mutations: readNonNegativeInteger(record.mutations),
    usage: normalizeTraceUsage(record.usage),
    finalText: brainIngestTracePreview(
      readString(record.finalText),
      BRAIN_INGEST_TRACE_FINAL_TEXT_LENGTH,
    ),
    toolCalls,
    truncatedToolCalls: readNonNegativeInteger(record.truncatedToolCalls),
    webSearchCount: readNonNegativeInteger(record.webSearchCount),
    webSearchCostUsdMicros: readNonNegativeInteger(record.webSearchCostUsdMicros),
    ...(triage ? { triage } : {}),
    ...(budget ? { budget } : {}),
    createdAt: readString(record.createdAt),
  };
}

export function hasBrainIngestTrace(value: unknown): boolean {
  return normalizeBrainIngestTrace(value) !== null;
}

export function sanitizeBrainIngestTraceArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, BRAIN_INGEST_TRACE_MAX_ARGS)
    .map((item) =>
      brainIngestTracePreview(
        typeof item === "string" ? item : String(item),
        BRAIN_INGEST_TRACE_ARG_PREVIEW_LENGTH,
      ),
    );
}

export function brainIngestTracePreview(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 14))}\n[truncated]`;
}

function normalizeTriageTrace(value: unknown): BrainIngestTriageTrace | undefined {
  const record = readRecord(value);
  if (!record || (record.decision !== "skip" && record.decision !== "ingest")) {
    return undefined;
  }
  const entityHints = readArray(record.entityHints)
    .slice(0, BRAIN_INGEST_TRIAGE_MAX_ENTITY_HINTS)
    .flatMap((hint): string[] => {
      if (typeof hint !== "string") return [];
      const normalized = hint.replace(/\s+/g, " ").trim();
      if (!normalized) return [];
      return [brainIngestTracePreview(normalized, BRAIN_INGEST_TRIAGE_ENTITY_HINT_LENGTH)];
    });
  return {
    model: readString(record.model),
    decision: record.decision,
    reason: brainIngestTracePreview(
      readString(record.reason).trim(),
      BRAIN_INGEST_TRIAGE_REASON_LENGTH,
    ),
    entityHints,
    usage: normalizeTraceUsage(record.usage),
    modelCostUsdMicros: readNonNegativeInteger(record.modelCostUsdMicros),
  };
}

function normalizeTraceUsage(value: unknown): BrainIngestTraceUsage {
  const record = readRecord(value);
  return {
    inputTokens: readNullableNonNegativeInteger(record?.inputTokens),
    outputTokens: readNullableNonNegativeInteger(record?.outputTokens),
    totalTokens: readNullableNonNegativeInteger(record?.totalTokens),
    cacheReadInputTokens: readNullableNonNegativeInteger(record?.cacheReadInputTokens),
    cacheWriteInputTokens: readNullableNonNegativeInteger(record?.cacheWriteInputTokens),
  };
}

function normalizeBudget(value: unknown): BrainIngestBudget | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  return {
    limitUsdMicros: readNonNegativeInteger(record.limitUsdMicros),
    stopThresholdUsdMicros: readNonNegativeInteger(record.stopThresholdUsdMicros),
    modelCostUsdMicros: readNonNegativeInteger(record.modelCostUsdMicros),
    brainQueryCostUsdMicros: readNonNegativeInteger(record.brainQueryCostUsdMicros),
    webSearchCostUsdMicros: readNonNegativeInteger(record.webSearchCostUsdMicros),
    totalCostUsdMicros: readNonNegativeInteger(record.totalCostUsdMicros),
    accountingComplete: record.accountingComplete === true,
    exhausted: record.exhausted === true,
  };
}

function normalizeTraceToolCall(value: unknown): BrainIngestTraceToolCall | null {
  const record = readRecord(value);
  if (!record || record.toolName !== "goat_brain") return null;
  const status = normalizeTraceToolCallStatus(record.status);
  if (!status) return null;

  return {
    id: readString(record.id),
    toolName: "goat_brain",
    command: readString(record.command),
    args: sanitizeBrainIngestTraceArgs(record.args),
    stdinPreview:
      typeof record.stdinPreview === "string"
        ? brainIngestTracePreview(record.stdinPreview, BRAIN_INGEST_TRACE_STDIN_PREVIEW_LENGTH)
        : null,
    status,
    mutating: record.mutating === true,
    exitCode: readNullableInteger(record.exitCode),
    stdoutPreview: brainIngestTracePreview(
      readString(record.stdoutPreview),
      BRAIN_INGEST_TRACE_OUTPUT_PREVIEW_LENGTH,
    ),
    stderrPreview: brainIngestTracePreview(
      readString(record.stderrPreview),
      BRAIN_INGEST_TRACE_OUTPUT_PREVIEW_LENGTH,
    ),
    errorPreview: brainIngestTracePreview(
      readString(record.errorPreview),
      BRAIN_INGEST_TRACE_OUTPUT_PREVIEW_LENGTH,
    ),
    startedAt: readString(record.startedAt),
    completedAt: readString(record.completedAt),
  };
}

function normalizeTraceToolCallStatus(value: unknown): BrainIngestTraceToolCallStatus | null {
  if (value === "completed" || value === "failed" || value === "blocked") return value;
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNullableInteger(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function readNullableNonNegativeInteger(value: unknown): number | null {
  const parsed = readNullableInteger(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function readNonNegativeInteger(value: unknown): number {
  return readNullableNonNegativeInteger(value) ?? 0;
}
