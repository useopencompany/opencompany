import {
  type Attributes,
  context,
  metrics,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

export const GOAT_OBSERVABILITY_SERVICE_NAME = "opencompany-goat";
export const GOAT_OTEL_METRIC_EXPORT_INTERVAL_MS = 60_000;
export const GOAT_OTEL_TRACE_SAMPLE_RATE = 1;

export const GOAT_SPANS = {
  signupCompleted: "goat.signup.completed",
  chatTurn: "goat.chat.turn",
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

export const GOAT_METRICS = {
  signupsTotal: "goat.signups_total",
  runsTotal: "goat.runs_total",
  runDurationMs: "goat.run_duration_ms",
  chatTurnsTotal: "goat.chat.turns_total",
  chatTurnDurationMs: "goat.chat.turn_duration_ms",
  chatTasksStartedTotal: "goat.chat.tasks_started_total",
  chatWebSearchesTotal: "goat.chat.web_searches_total",
  chatWebSearchCostUsdMicros: "goat.chat.web_search_cost_usd_micros",
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

export type GoatRunSurface = "chat" | "task" | "brain_ingest";
export type GoatSignupSource = "user_sync";
export type GoatOutcome = "success" | "failure" | "skipped" | "aborted";

export type GoatFailureCategory =
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

export type GoatAttributeValue = string | number | boolean | null | undefined;
export type GoatAttributes = Record<string, GoatAttributeValue>;
export type GoatGatewayFeature = "chat" | "chat-title" | "task" | "brain-ingest" | "brain-query";

export type GoatGatewayAttribution = {
  user?: string;
  tags: string[];
};

type GoatGatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GoatGatewayJsonValue[]
  | { [key: string]: GoatGatewayJsonValue };
type GoatGatewayProviderOptionValue = { [key: string]: GoatGatewayJsonValue };
export type GoatGatewayProviderOptions = { [key: string]: { [key: string]: GoatGatewayJsonValue } };

export type GoatGatewayAttributionInput = {
  userWorkosId?: string | null | undefined;
  feature: GoatGatewayFeature;
  env?: string | null | undefined;
  chatSessionId?: string | null | undefined;
  taskId?: string | null | undefined;
  ingestJobId?: string | null | undefined;
  brainRef?: string | null | undefined;
  tags?: readonly string[];
};

export type GoatSpanHandle = {
  setAttributes(attributes: GoatAttributes): void;
  runInContext<T>(run: () => T): T;
  fail(error: unknown, attributes?: GoatAttributes): GoatFailureCategory;
  end(attributes?: GoatAttributes): void;
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
  "goat.token_direction",
  "goat.signup_source",
]);

export function isGoatObservabilityEnabled(env: EnvLike = readEnv()) {
  return enabledFromEnv(env.GOAT_OBSERVABILITY_ENABLED);
}

export function hashGoatUserId(userWorkosId: string | null | undefined) {
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

export function goatGatewayReportingUser(userWorkosId: string | null | undefined) {
  const hash = hashGoatUserId(userWorkosId);
  return hash ? `goat-${hash}` : undefined;
}

export function createGoatGatewayAttribution(
  input: GoatGatewayAttributionInput,
): GoatGatewayAttribution {
  const user = goatGatewayReportingUser(input.userWorkosId);
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

export function goatGatewayProviderOptions(
  attribution: GoatGatewayAttribution,
  existing?: GoatGatewayProviderOptions,
): GoatGatewayProviderOptions {
  const existingGateway =
    existing && isPlainRecord(existing.gateway)
      ? (existing.gateway as GoatGatewayProviderOptionValue)
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

export function goatGatewayReportingHeaders(
  attribution: GoatGatewayAttribution,
): Record<string, string> {
  return {
    ...(attribution.user ? { "ai-reporting-user": attribution.user } : {}),
    ...(attribution.tags.length > 0 ? { "ai-reporting-tags": attribution.tags.join(",") } : {}),
  };
}

export function sanitizeGoatAttributes(attributes: GoatAttributes | undefined): Attributes {
  if (!attributes) return {};
  const sanitized: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!isSafeAttributeKey(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function sanitizeGoatMetricAttributes(attributes: GoatAttributes | undefined): Attributes {
  if (!attributes) return {};
  const sanitized: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!LOW_CARDINAL_METRIC_ATTRIBUTE_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function categorizeGoatFailure(error: unknown): GoatFailureCategory {
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

export function startGoatSpan(name: string, attributes?: GoatAttributes): GoatSpanHandle {
  if (!isGoatObservabilityEnabled()) return noopSpanHandle;
  const span = tracer.startSpan(
    name,
    { attributes: sanitizeGoatAttributes(attributes) },
    context.active(),
  );
  return createSpanHandle(span);
}

export async function withGoatSpan<T>(
  name: string,
  attributes: GoatAttributes | undefined,
  run: (span: GoatSpanHandle) => Promise<T>,
): Promise<T> {
  if (!isGoatObservabilityEnabled()) return run(noopSpanHandle);
  return tracer.startActiveSpan(
    name,
    { attributes: sanitizeGoatAttributes(attributes) },
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

export async function timeGoatSpan<T>(
  name: string,
  attributes: GoatAttributes | undefined,
  histogramName: string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await withGoatSpan(name, attributes, () => run());
  } finally {
    recordGoatHistogram(histogramName, Math.round(performance.now() - startedAt), attributes);
  }
}

export function recordGoatCounter(name: string, value = 1, attributes?: GoatAttributes) {
  if (!isGoatObservabilityEnabled()) return;
  const counter = counters.get(name) ?? meter.createCounter(name);
  counters.set(name, counter);
  counter.add(value, sanitizeGoatMetricAttributes(attributes));
}

export function recordGoatHistogram(name: string, value: number, attributes?: GoatAttributes) {
  if (!isGoatObservabilityEnabled()) return;
  const histogram = histograms.get(name) ?? meter.createHistogram(name, { unit: "ms" });
  histograms.set(name, histogram);
  histogram.record(value, sanitizeGoatMetricAttributes(attributes));
}

export function recordGoatRunOutcome(input: {
  surface: GoatRunSurface;
  durationMs: number;
  outcome: GoatOutcome;
  attributes?: GoatAttributes;
}) {
  const attributes = {
    ...input.attributes,
    "goat.surface": input.surface,
    "goat.outcome": input.outcome,
  };
  recordGoatCounter(GOAT_METRICS.runsTotal, 1, attributes);
  recordGoatHistogram(GOAT_METRICS.runDurationMs, input.durationMs, attributes);

  if (input.surface === "chat") {
    recordGoatCounter(GOAT_METRICS.chatTurnsTotal, 1, attributes);
    recordGoatHistogram(GOAT_METRICS.chatTurnDurationMs, input.durationMs, attributes);
    return;
  }

  if (input.surface === "task") {
    recordGoatCounter(GOAT_METRICS.taskRunsTotal, 1, attributes);
    recordGoatHistogram(GOAT_METRICS.taskRunDurationMs, input.durationMs, attributes);
    return;
  }

  recordGoatCounter(GOAT_METRICS.brainIngestRunsTotal, 1, attributes);
  recordGoatHistogram(GOAT_METRICS.brainIngestRunDurationMs, input.durationMs, attributes);
}

export function recordGoatSignup(
  input: { source?: GoatSignupSource; attributes?: GoatAttributes } = {},
) {
  const attributes: GoatAttributes = {
    ...input.attributes,
    "goat.signup_source": input.source ?? "user_sync",
    "goat.outcome": "success",
  };
  const span = startGoatSpan(GOAT_SPANS.signupCompleted, attributes);
  span.end(attributes);
  recordGoatCounter(GOAT_METRICS.signupsTotal, 1, attributes);
}

export function recordGoatChatTurn(input: {
  durationMs: number;
  outcome: GoatOutcome;
  attributes?: GoatAttributes;
}) {
  recordGoatRunOutcome({ ...input, surface: "chat" });
}

export function recordGoatTaskDispatch(input: {
  durationMs: number;
  outcome: GoatOutcome;
  attributes?: GoatAttributes;
}) {
  const attributes = { ...input.attributes, "goat.outcome": input.outcome };
  recordGoatCounter(GOAT_METRICS.taskDispatchesTotal, 1, attributes);
  recordGoatHistogram(GOAT_METRICS.taskDispatchDurationMs, input.durationMs, attributes);
}

export function recordGoatTaskRun(input: {
  durationMs: number;
  outcome: GoatOutcome;
  attributes?: GoatAttributes;
}) {
  recordGoatRunOutcome({ ...input, surface: "task" });
}

export function recordGoatBrainIngestRun(input: {
  durationMs: number;
  outcome: GoatOutcome;
  attributes?: GoatAttributes;
}) {
  recordGoatRunOutcome({ ...input, surface: "brain_ingest" });
}

export function recordGoatBrainIngestSpend(input: {
  costUsdMicros: number;
  source: "model" | "brain_query" | "web_search";
  attributes?: GoatAttributes;
}) {
  if (!Number.isFinite(input.costUsdMicros) || input.costUsdMicros <= 0) return;
  recordGoatCounter(GOAT_METRICS.brainIngestSpendUsdMicros, Math.round(input.costUsdMicros), {
    ...input.attributes,
    "goat.surface": "brain_ingest",
    "goat.cost_source": input.source,
  });
}

export function recordGoatBrainIngestBudgetExhausted(attributes?: GoatAttributes) {
  recordGoatCounter(GOAT_METRICS.brainIngestBudgetExhaustionsTotal, 1, {
    ...attributes,
    "goat.surface": "brain_ingest",
    "goat.budget_exhausted": true,
  });
}

export function recordGoatToolCall(input: {
  durationMs: number;
  outcome: GoatOutcome;
  attributes?: GoatAttributes;
}) {
  const attributes = { ...input.attributes, "goat.outcome": input.outcome };
  recordGoatCounter(GOAT_METRICS.toolCallsTotal, 1, attributes);
  recordGoatHistogram(GOAT_METRICS.toolCallDurationMs, input.durationMs, attributes);
}

export function recordGoatModelUsageTokens(input: {
  tokens: number;
  direction: "input" | "output" | "total";
  attributes?: GoatAttributes;
}) {
  recordGoatCounter(GOAT_METRICS.modelUsageTokens, input.tokens, {
    ...input.attributes,
    "goat.token_direction": input.direction,
  });
}

export function recordGoatModelCost(input: { costUsdMicros: number; attributes?: GoatAttributes }) {
  if (!Number.isFinite(input.costUsdMicros) || input.costUsdMicros <= 0) return;
  recordGoatCounter(GOAT_METRICS.modelCostUsdMicros, Math.round(input.costUsdMicros), {
    ...input.attributes,
  });
}

function createSpanHandle(span: Span): GoatSpanHandle {
  return {
    setAttributes(attributes) {
      span.setAttributes(sanitizeGoatAttributes(attributes));
    },
    runInContext(run) {
      return context.with(trace.setSpan(context.active(), span), run);
    },
    fail(error, attributes) {
      const failureCategory = categorizeGoatFailure(error);
      span.setAttributes(
        sanitizeGoatAttributes({
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
      if (attributes) span.setAttributes(sanitizeGoatAttributes(attributes));
      span.end();
    },
  };
}

const noopSpanHandle: GoatSpanHandle = {
  setAttributes() {},
  runInContext(run) {
    return run();
  },
  fail(error) {
    return categorizeGoatFailure(error);
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
