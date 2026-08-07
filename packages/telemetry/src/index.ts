import {
  context,
  metrics,
  type Attributes as OtelAttributes,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

export const OBSERVABILITY_SERVICE_NAME = "opencompany-goat";
export const OTEL_METRIC_EXPORT_INTERVAL_MS = 60_000;
export const OTEL_TRACE_SAMPLE_RATE = 1;

export const SPANS = {
  signupCompleted: "goat.signup.completed",
  chatTurn: "goat.chat.turn",
  chatActionCall: "goat.chat.action_call",
  taskDispatch: "goat.task.dispatch",
  taskClaim: "goat.task.claim",
  taskRun: "goat.task.run",
  taskPlan: "goat.task.plan",
  taskModelStream: "goat.task.model_stream",
  taskToolCall: "goat.task.tool_call",
  taskComplete: "goat.task.complete",
  taskFail: "goat.task.fail",
  brainIngestRun: "goat.brain_ingest.run",
  brainIngestComplete: "goat.brain_ingest.complete",
  brainIngestFail: "goat.brain_ingest.fail",
} as const;

export const METRICS = {
  signupsTotal: "goat.signups_total",
  runsTotal: "goat.runs_total",
  runDurationMs: "goat.run_duration_ms",
  chatTurnsTotal: "goat.chat.turns_total",
  chatTurnDurationMs: "goat.chat.turn_duration_ms",
  chatTasksStartedTotal: "goat.chat.tasks_started_total",
  chatWebFetchesTotal: "goat.chat.web_fetches_total",
  chatWebFetchCostUsdMicros: "goat.chat.web_fetch_cost_usd_micros",
  chatWebSearchesTotal: "goat.chat.web_searches_total",
  chatWebSearchCostUsdMicros: "goat.chat.web_search_cost_usd_micros",
  chatActionCallsTotal: "goat.chat.action_calls_total",
  chatActionCallDurationMs: "goat.chat.action_call_duration_ms",
  capabilityRunsTotal: "goat.capability.runs_total",
  capabilityProviderCostUsdMicros: "goat.capability.provider_cost_usd_micros",
  capabilitySettlementLagMs: "goat.capability.settlement_lag_ms",
  capabilityApprovalsTotal: "goat.capability.approvals_total",
  capabilityWalletBalanceUsdMicros: "goat.capability.wallet_balance_usd_micros",
  codexChatQueueWaitMs: "goat.codex_chat.queue_wait_ms",
  taskDispatchesTotal: "goat.task_dispatches_total",
  taskDispatchDurationMs: "goat.task_dispatch_duration_ms",
  taskRunsTotal: "goat.task_runs_total",
  taskRunDurationMs: "goat.task_run_duration_ms",
  taskStageDurationMs: "goat.task_stage_duration_ms",
  brainIngestRunsTotal: "goat.brain_ingest_runs_total",
  brainIngestRunDurationMs: "goat.brain_ingest_run_duration_ms",
  brainIngestSpendUsdMicros: "goat.brain_ingest_spend_usd_micros",
  brainIngestBudgetExhaustionsTotal: "goat.brain_ingest_budget_exhaustions_total",
  toolCallsTotal: "goat.tool_calls_total",
  toolCallDurationMs: "goat.tool_call_duration_ms",
  modelUsageTokens: "goat.model_usage_tokens",
  modelCostUsdMicros: "goat.model_cost_usd_micros",
} as const;

export type RunSurface = "chat" | "task" | "brain_ingest";
export type SignupSource = "user_sync";
export type Outcome = "success" | "failure" | "skipped" | "aborted";

export type FailureCategory =
  | "model_provider"
  | "tool"
  | "auth"
  | "integration"
  | "budget"
  | "lease_lost"
  | "timeout"
  | "validation"
  | "runner_unconfigured"
  | "network"
  | "bug"
  | "unknown";

export type AttributeValue = string | number | boolean | null | undefined;
export type Attributes = Record<string, AttributeValue>;
export type GatewayFeature =
  | "chat"
  | "chat-router"
  | "chat-title"
  | "task"
  | "brain-ingest"
  | "brain-query"
  | "slack-bot";

export type GatewayAttribution = {
  user?: string;
  tags: string[];
};

type GatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GatewayJsonValue[]
  | { [key: string]: GatewayJsonValue };
type GatewayProviderOptionValue = { [key: string]: GatewayJsonValue };
export type GatewayProviderOptions = { [key: string]: { [key: string]: GatewayJsonValue } };

export type GatewayAttributionInput = {
  userWorkosId?: string | null | undefined;
  feature: GatewayFeature;
  env?: string | null | undefined;
  chatSessionId?: string | null | undefined;
  taskId?: string | null | undefined;
  ingestJobId?: string | null | undefined;
  brainRef?: string | null | undefined;
  tags?: readonly string[];
};

export type SpanHandle = {
  setAttributes(attributes: Attributes): void;
  runInContext<T>(run: () => T): T;
  fail(error: unknown, attributes?: Attributes): FailureCategory;
  end(attributes?: Attributes): void;
};

const meter = metrics.getMeter("opencompany-goat-observability");
const tracer = trace.getTracer("opencompany-goat-observability");
const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();

const SENSITIVE_ATTRIBUTE_PARTS = [
  "prompt",
  "content",
  "text",
  "input",
  "output",
  "result",
  "args",
  "debug",
  "trace",
  "email",
  "token",
  "secret",
  "oauth",
  "credential",
  "calendar",
];

const SAFE_ATTRIBUTE_KEYS = new Set(["goat.token_direction"]);
const LOW_CARDINAL_METRIC_ATTRIBUTE_KEYS = new Set([
  "goat.surface",
  "goat.outcome",
  "goat.failure_category",
  "goat.model",
  "goat.model_selection",
  "goat.router_tier",
  "goat.router_reason",
  "goat.router_outcome",
  "goat.engine",
  "goat.status",
  "goat.stage",
  "goat.attempt",
  "goat.task_started",
  "goat.ingest_kind",
  "goat.source_provider",
  "goat.source_type",
  "goat.cost_source",
  "goat.budget_exhausted",
  "goat.budget_accounting_complete",
  "goat.web_search_provider",
  "goat.web_search_operation",
  "goat.action",
  "goat.action_provider",
  "goat.capability_source",
  "goat.capability_action",
  "goat.approval_decision",
  "goat.token_direction",
  "goat.signup_source",
]);

export function isObservabilityEnabled(env: EnvLike = readEnv()) {
  return enabledFromEnv(env.TELEMETRY_ENABLED);
}

export function hashUserId(userWorkosId: string | null | undefined) {
  const value = userWorkosId?.trim();
  if (!value) return undefined;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

export function gatewayReportingUser(userWorkosId: string | null | undefined) {
  const hash = hashUserId(userWorkosId);
  return hash ? `goat-${hash}` : undefined;
}

export function createGatewayAttribution(input: GatewayAttributionInput): GatewayAttribution {
  const user = gatewayReportingUser(input.userWorkosId);
  const env = readEnv();
  return {
    ...(user ? { user } : {}),
    tags: normalizeGatewayTags([
      "app:goat",
      `env:${input.env?.trim() || env.VERCEL_ENV || env.NODE_ENV || "unknown"}`,
      `feature:${input.feature}`,
      ...(input.chatSessionId ? [contextTag("chat", input.chatSessionId)] : []),
      ...(input.taskId ? [contextTag("task", input.taskId)] : []),
      ...(input.ingestJobId ? [contextTag("ingest", input.ingestJobId)] : []),
      ...(input.brainRef ? [contextTag("brain", input.brainRef)] : []),
      ...(input.tags ?? []),
    ]),
  };
}

export function gatewayProviderOptions(
  attribution: GatewayAttribution,
  existing?: GatewayProviderOptions,
): GatewayProviderOptions {
  const existingGateway =
    existing && isPlainRecord(existing.gateway)
      ? (existing.gateway as GatewayProviderOptionValue)
      : undefined;
  return {
    ...(existing ?? {}),
    gateway: {
      ...(existingGateway ?? {}),
      ...(attribution.user ? { user: attribution.user } : {}),
      tags: attribution.tags,
    },
  };
}

export function gatewayReportingHeaders(attribution: GatewayAttribution): Record<string, string> {
  return {
    ...(attribution.user ? { "ai-reporting-user": attribution.user } : {}),
    ...(attribution.tags.length > 0 ? { "ai-reporting-tags": attribution.tags.join(",") } : {}),
  };
}

export function sanitizeAttributes(attributes: Attributes | undefined): OtelAttributes {
  if (!attributes) return {};
  const sanitized: OtelAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!isSafeAttributeKey(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function sanitizeMetricAttributes(attributes: Attributes | undefined): OtelAttributes {
  if (!attributes) return {};
  const sanitized: OtelAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!LOW_CARDINAL_METRIC_ATTRIBUTE_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function categorizeFailure(error: unknown): FailureCategory {
  const message = errorMessage(error).toLowerCase();
  const name = error instanceof Error ? error.name.toLowerCase() : "";

  if (message.includes("budget exhausted") || name.includes("budgeterror")) return "budget";
  if (message.includes("lease lost")) return "lease_lost";
  if (message.includes("runner is not configured") || message.includes("runner request skipped")) {
    return "runner_unconfigured";
  }
  if (name.includes("abort") || message.includes("aborted")) return "timeout";
  if (name.includes("timeout") || message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }
  if (
    message.includes("gmail") ||
    message.includes("calendar") ||
    message.includes("google") ||
    message.includes("integration")
  ) {
    return "integration";
  }
  if (
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("api key") ||
    message.includes("api_key") ||
    message.includes("auth")
  ) {
    return "auth";
  }
  if (
    message.includes("tool") ||
    message.includes("exa_search") ||
    message.includes("exa search")
  ) {
    return "tool";
  }
  if (
    message.includes("invalid") ||
    message.includes("required") ||
    message.includes("validation") ||
    message.includes("malformed")
  ) {
    return "validation";
  }
  if (
    message.includes("model") ||
    message.includes("gateway") ||
    message.includes("stream") ||
    message.includes("finish reason")
  ) {
    return "model_provider";
  }
  if (
    message.includes("fetch failed") ||
    message.includes("econn") ||
    message.includes("network") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504")
  ) {
    return "network";
  }
  if (
    name.includes("typeerror") ||
    name.includes("referenceerror") ||
    name.includes("syntaxerror")
  ) {
    return "bug";
  }
  return "unknown";
}

export function startSpan(name: string, attributes?: Attributes): SpanHandle {
  if (!isObservabilityEnabled()) return noopSpanHandle;
  const span = tracer.startSpan(
    name,
    { attributes: sanitizeAttributes(attributes) },
    context.active(),
  );
  return createSpanHandle(span);
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes | undefined,
  run: (span: SpanHandle) => Promise<T>,
): Promise<T> {
  if (!isObservabilityEnabled()) return run(noopSpanHandle);
  return tracer.startActiveSpan(
    name,
    { attributes: sanitizeAttributes(attributes) },
    async (span) => {
      const handle = createSpanHandle(span);
      try {
        const result = await run(handle);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        handle.fail(error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export async function timeSpan<T>(
  name: string,
  attributes: Attributes | undefined,
  histogramName: string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await withSpan(name, attributes, () => run());
  } finally {
    recordHistogram(histogramName, Math.round(performance.now() - startedAt), attributes);
  }
}

export function recordCounter(name: string, value = 1, attributes?: Attributes) {
  if (!isObservabilityEnabled()) return;
  const counter = counters.get(name) ?? meter.createCounter(name);
  counters.set(name, counter);
  counter.add(value, sanitizeMetricAttributes(attributes));
}

export function recordHistogram(name: string, value: number, attributes?: Attributes) {
  if (!isObservabilityEnabled()) return;
  const histogram = histograms.get(name) ?? meter.createHistogram(name, { unit: "ms" });
  histograms.set(name, histogram);
  histogram.record(value, sanitizeMetricAttributes(attributes));
}

export function recordRunOutcome(input: {
  surface: RunSurface;
  durationMs: number;
  outcome: Outcome;
  attributes?: Attributes;
}) {
  const attributes = {
    ...input.attributes,
    "goat.surface": input.surface,
    "goat.outcome": input.outcome,
  };
  recordCounter(METRICS.runsTotal, 1, attributes);
  recordHistogram(METRICS.runDurationMs, input.durationMs, attributes);

  if (input.surface === "chat") {
    recordCounter(METRICS.chatTurnsTotal, 1, attributes);
    recordHistogram(METRICS.chatTurnDurationMs, input.durationMs, attributes);
    return;
  }

  if (input.surface === "task") {
    recordCounter(METRICS.taskRunsTotal, 1, attributes);
    recordHistogram(METRICS.taskRunDurationMs, input.durationMs, attributes);
    return;
  }

  recordCounter(METRICS.brainIngestRunsTotal, 1, attributes);
  recordHistogram(METRICS.brainIngestRunDurationMs, input.durationMs, attributes);
}

export function recordSignup(input: { source?: SignupSource; attributes?: Attributes } = {}) {
  const attributes: Attributes = {
    ...input.attributes,
    "goat.signup_source": input.source ?? "user_sync",
    "goat.outcome": "success",
  };
  const span = startSpan(SPANS.signupCompleted, attributes);
  span.end(attributes);
  recordCounter(METRICS.signupsTotal, 1, attributes);
}

export function recordChatTurn(input: {
  durationMs: number;
  outcome: Outcome;
  attributes?: Attributes;
}) {
  recordRunOutcome({ ...input, surface: "chat" });
}

export function recordTaskDispatch(input: {
  durationMs: number;
  outcome: Outcome;
  attributes?: Attributes;
}) {
  const attributes = { ...input.attributes, "goat.outcome": input.outcome };
  recordCounter(METRICS.taskDispatchesTotal, 1, attributes);
  recordHistogram(METRICS.taskDispatchDurationMs, input.durationMs, attributes);
}

export function recordTaskRun(input: {
  durationMs: number;
  outcome: Outcome;
  attributes?: Attributes;
}) {
  recordRunOutcome({ ...input, surface: "task" });
}

export function recordBrainIngestRun(input: {
  durationMs: number;
  outcome: Outcome;
  attributes?: Attributes;
}) {
  recordRunOutcome({ ...input, surface: "brain_ingest" });
}

export function recordBrainIngestSpend(input: {
  costUsdMicros: number;
  source: "model" | "brain_query" | "web_search";
  attributes?: Attributes;
}) {
  if (!Number.isFinite(input.costUsdMicros) || input.costUsdMicros <= 0) return;
  recordCounter(METRICS.brainIngestSpendUsdMicros, Math.round(input.costUsdMicros), {
    ...input.attributes,
    "goat.surface": "brain_ingest",
    "goat.cost_source": input.source,
  });
}

export function recordBrainIngestBudgetExhausted(attributes?: Attributes) {
  recordCounter(METRICS.brainIngestBudgetExhaustionsTotal, 1, {
    ...attributes,
    "goat.surface": "brain_ingest",
    "goat.budget_exhausted": true,
  });
}

export function recordToolCall(input: {
  durationMs: number;
  outcome: Outcome;
  attributes?: Attributes;
}) {
  const attributes = { ...input.attributes, "goat.outcome": input.outcome };
  recordCounter(METRICS.toolCallsTotal, 1, attributes);
  recordHistogram(METRICS.toolCallDurationMs, input.durationMs, attributes);
}

export function recordModelUsageTokens(input: {
  tokens: number;
  direction: "input" | "output" | "total";
  attributes?: Attributes;
}) {
  recordCounter(METRICS.modelUsageTokens, input.tokens, {
    ...input.attributes,
    "goat.token_direction": input.direction,
  });
}

export function recordModelCost(input: { costUsdMicros: number; attributes?: Attributes }) {
  if (!Number.isFinite(input.costUsdMicros) || input.costUsdMicros <= 0) return;
  recordCounter(METRICS.modelCostUsdMicros, Math.round(input.costUsdMicros), {
    ...input.attributes,
  });
}

function createSpanHandle(span: Span): SpanHandle {
  return {
    setAttributes(attributes) {
      span.setAttributes(sanitizeAttributes(attributes));
    },
    runInContext(run) {
      return context.with(trace.setSpan(context.active(), span), run);
    },
    fail(error, attributes) {
      const failureCategory = categorizeFailure(error);
      span.setAttributes(
        sanitizeAttributes({
          ...attributes,
          "goat.outcome": "failure",
          "goat.failure_category": failureCategory,
        }),
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException({ name: errorName(error), message: failureCategory });
      return failureCategory;
    },
    end(attributes) {
      if (attributes) span.setAttributes(sanitizeAttributes(attributes));
      span.end();
    },
  };
}

const noopSpanHandle: SpanHandle = {
  setAttributes() {},
  runInContext(run) {
    return run();
  },
  fail(error) {
    return categorizeFailure(error);
  },
  end() {},
};

function isSafeAttributeKey(key: string) {
  if (!key.startsWith("goat.") && !key.startsWith("service.")) return false;
  if (SAFE_ATTRIBUTE_KEYS.has(key)) return true;
  const lower = key.toLowerCase();
  return !SENSITIVE_ATTRIBUTE_PARTS.some((part) => lower.includes(part));
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "Error";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeGatewayTags(tags: readonly string[]) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const value = normalizeGatewayTag(tag);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
    if (normalized.length >= 10) break;
  }
  return normalized;
}

function contextTag(prefix: string, value: string) {
  return `${prefix}:${value}`;
}

function normalizeGatewayTag(tag: string) {
  if (tag.includes("@")) return null;
  const normalized = tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || null;
}

type EnvLike = Record<string, string | undefined>;

function readEnv(): EnvLike {
  if (typeof process === "undefined") return {};
  return process.env;
}

function enabledFromEnv(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}
