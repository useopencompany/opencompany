import {
  type Attributes,
  context,
  metrics,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

export const GOAT_OBSERVABILITY_SERVICE_NAME = "opencompany-goat";

export const GOAT_SPANS = {
  chatTurn: "goat.chat.turn",
  taskDispatch: "goat.task.dispatch",
  taskClaim: "goat.task.claim",
  taskRun: "goat.task.run",
  taskPlan: "goat.task.plan",
  taskModelStream: "goat.task.model_stream",
  taskToolCall: "goat.task.tool_call",
  taskComplete: "goat.task.complete",
  taskFail: "goat.task.fail",
} as const;

export const GOAT_METRICS = {
  chatTurnsTotal: "goat.chat.turns_total",
  chatTurnDurationMs: "goat.chat.turn_duration_ms",
  chatTasksStartedTotal: "goat.chat.tasks_started_total",
  taskDispatchesTotal: "goat.task_dispatches_total",
  taskDispatchDurationMs: "goat.task_dispatch_duration_ms",
  taskRunsTotal: "goat.task_runs_total",
  taskRunDurationMs: "goat.task_run_duration_ms",
  taskStageDurationMs: "goat.task_stage_duration_ms",
  toolCallsTotal: "goat.tool_calls_total",
  toolCallDurationMs: "goat.tool_call_duration_ms",
  modelUsageTokens: "goat.model_usage_tokens",
} as const;

export type GoatOutcome = "success" | "failure" | "skipped" | "aborted";

export type GoatFailureCategory =
  | "model_provider"
  | "tool"
  | "auth"
  | "integration"
  | "lease_lost"
  | "timeout"
  | "validation"
  | "runner_unconfigured"
  | "network"
  | "bug"
  | "unknown";

export type GoatAttributeValue = string | number | boolean | null | undefined;
export type GoatAttributes = Record<string, GoatAttributeValue>;

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

export function categorizeGoatFailure(error: unknown): GoatFailureCategory {
  const message = errorMessage(error).toLowerCase();
  const name = error instanceof Error ? error.name.toLowerCase() : "";

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
  counter.add(value, sanitizeGoatAttributes(attributes));
}

export function recordGoatHistogram(name: string, value: number, attributes?: GoatAttributes) {
  if (!isGoatObservabilityEnabled()) return;
  const histogram = histograms.get(name) ?? meter.createHistogram(name, { unit: "ms" });
  histograms.set(name, histogram);
  histogram.record(value, sanitizeGoatAttributes(attributes));
}

export function recordGoatChatTurn(input: {
  durationMs: number;
  outcome: GoatOutcome;
  attributes?: GoatAttributes;
}) {
  const attributes = { ...input.attributes, "goat.outcome": input.outcome };
  recordGoatCounter(GOAT_METRICS.chatTurnsTotal, 1, attributes);
  recordGoatHistogram(GOAT_METRICS.chatTurnDurationMs, input.durationMs, attributes);
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
  const attributes = { ...input.attributes, "goat.outcome": input.outcome };
  recordGoatCounter(GOAT_METRICS.taskRunsTotal, 1, attributes);
  recordGoatHistogram(GOAT_METRICS.taskRunDurationMs, input.durationMs, attributes);
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

type EnvLike = Record<string, string | undefined>;

function readEnv(): EnvLike {
  if (typeof process === "undefined") return {};
  return process.env;
}

function enabledFromEnv(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}
