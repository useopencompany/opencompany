export type LogLevel = "debug" | "info" | "warn" | "error";

type LogLevelSetting = LogLevel | "off";

export type LogFields = Record<string, unknown>;

export type ObservabilityContext = {
  request_id?: string;
  trace_id?: string;
  span_id?: string;
  workspace_id?: string;
  user_id?: string;
  agent_id?: string;
  session_id?: string;
  message_id?: string;
  inngest_event_id?: string;
  inngest_run_id?: string;
  sandbox_id?: string;
  model_provider?: string;
  model_name?: string;
  [key: string]: unknown;
};

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export type ExceptionReporter = {
  captureException(error: unknown, fields: LogFields): unknown;
  flush?(): PromiseLike<boolean> | PromiseLike<void> | boolean | void;
};

export type TimingTrace = {
  id: string;
  name: string;
  startedAt: number;
  enabled: boolean;
  metadata?: LogFields;
  logger: Logger;
};

type CreateLoggerInput = {
  service: string;
  runtime?: string;
  defaultContext?: ObservabilityContext;
};

type TimingOptions = {
  logger?: Logger;
};

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 2_000;

const defaultTimingLogger = createLogger({ service: "opencompany" });
const observabilityLogger = createLogger({ service: "opencompany-observability" });

let exceptionReporter: ExceptionReporter | undefined;
let browserObservabilityContext: ObservabilityContext = {};

export function createLogger(input: CreateLoggerInput): Logger {
  return {
    debug(message, fields) {
      emitLog("debug", input, message, fields);
    },
    info(message, fields) {
      emitLog("info", input, message, fields);
    },
    warn(message, fields) {
      emitLog("warn", input, message, fields);
    },
    error(message, fields) {
      emitLog("error", input, message, fields);
    },
  };
}

export function setExceptionReporter(reporter: ExceptionReporter | undefined) {
  exceptionReporter = isObservabilityEnabled() ? reporter : undefined;
}

export function setObservabilityContext(context: ObservabilityContext | undefined) {
  if (!isBrowser()) return;
  browserObservabilityContext = sanitizeLogFields(context) as ObservabilityContext;
}

export function captureException(error: unknown, fields?: LogFields) {
  const sanitizedFields = sanitizeLogFields({
    ...getCurrentObservabilityContext(),
    ...fields,
  });
  const errorFields = errorToLogFields(error);

  if (!isObservabilityEnabled() || !exceptionReporter) {
    observabilityLogger.error("Captured exception", {
      ...sanitizedFields,
      ...errorFields,
      observability_reporter: "local",
    });
    return;
  }

  try {
    const result = exceptionReporter.captureException(error, sanitizedFields);
    if (isPromiseLike(result)) {
      Promise.resolve(result).catch((reporterError: unknown) => {
        observabilityLogger.warn("Exception reporter failed", {
          error: reporterError,
        });
      });
    }
  } catch (reporterError) {
    observabilityLogger.warn("Exception reporter failed", {
      error: reporterError,
    });
  }
}

function getCurrentObservabilityContext() {
  return isBrowser() ? browserObservabilityContext : {};
}

export async function flushObservability() {
  if (!isObservabilityEnabled() || !exceptionReporter?.flush) return;

  try {
    await exceptionReporter.flush();
  } catch (error) {
    observabilityLogger.warn("Exception reporter flush failed", { error });
  }
}

export function startTimingTrace(
  name: string,
  metadata?: LogFields,
  options?: TimingOptions,
): TimingTrace {
  const trace: TimingTrace = {
    id: newTraceId(),
    name,
    startedAt: now(),
    enabled: isTimingEnabled(),
    ...(metadata ? { metadata } : {}),
    logger: options?.logger ?? defaultTimingLogger,
  };

  if (trace.enabled) {
    logTiming(trace, "start", 0, metadata);
  }

  return trace;
}

export async function timeAsync<T>(
  trace: TimingTrace | undefined,
  step: string,
  run: () => Promise<T>,
  metadata?: LogFields,
): Promise<T> {
  if (!trace?.enabled) return run();

  const startedAt = now();
  try {
    const result = await run();
    logTiming(trace, step, now() - startedAt, metadata);
    return result;
  } catch (error) {
    logTiming(trace, step, now() - startedAt, {
      ...metadata,
      error,
    });
    throw error;
  }
}

export function endTimingTrace(trace: TimingTrace | undefined, metadata?: LogFields) {
  if (!trace?.enabled) return;
  logTiming(trace, "total", now() - trace.startedAt, metadata);
}

export function sanitizeLogFields(fields: LogFields | undefined): LogFields {
  if (!fields) return {};

  const sanitized = sanitizeValue(fields, 0, new WeakSet<object>());
  return isPlainRecord(sanitized) ? sanitized : {};
}

export function errorToLogFields(error: unknown): LogFields {
  return {
    error: sanitizeValue(error, 0, new WeakSet<object>()),
  };
}

function emitLog(
  level: LogLevel,
  input: CreateLoggerInput,
  message: string,
  fields: LogFields | undefined,
) {
  if (!shouldLog(level)) return;

  const record = {
    ...sanitizeLogFields(input.defaultContext),
    ...sanitizeLogFields(getServerRuntimeContext()),
    ...sanitizeLogFields(fields),
    timestamp: new Date().toISOString(),
    level,
    message,
    "service.name": input.service,
    environment: getEnvironment(),
    release: getRelease(),
    ...(input.runtime ? { runtime: input.runtime } : {}),
  };

  writeLog(level, JSON.stringify(record));
}

function getServerRuntimeContext(): LogFields {
  if (isBrowser()) return {};

  return compactLogFields({
    preview_env: isTrue(getEnv("PREVIEW_ENV")) ? true : undefined,
    preview_pr_number: getEnv("PREVIEW_PR_NUMBER"),
    render_git_commit: getEnv("RENDER_GIT_COMMIT"),
    render_service_id: getEnv("RENDER_SERVICE_ID"),
    render_instance_id: getEnv("RENDER_INSTANCE_ID"),
  });
}

function compactLogFields(fields: LogFields): LogFields {
  const compacted: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") compacted[key] = value;
  }
  return compacted;
}

function shouldLog(level: LogLevel) {
  const configured = getLogLevel();
  if (configured === "off") return false;
  return LOG_LEVELS[level] >= LOG_LEVELS[configured];
}

function getLogLevel(): LogLevelSetting {
  const raw = getEnv(
    isBrowser() ? "NEXT_PUBLIC_OBSERVABILITY_LOG_LEVEL" : "OBSERVABILITY_LOG_LEVEL",
  );
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "off") {
    return raw;
  }
  return "info";
}

function getEnvironment() {
  if (isBrowser()) {
    return getEnv("NEXT_PUBLIC_OBSERVABILITY_ENV") ?? getEnv("NODE_ENV") ?? "development";
  }
  return getEnv("OBSERVABILITY_ENV") ?? getEnv("VERCEL_ENV") ?? getEnv("NODE_ENV") ?? "development";
}

function getRelease() {
  if (isBrowser()) {
    return getEnv("NEXT_PUBLIC_OBSERVABILITY_RELEASE") ?? "local";
  }
  return (
    getEnv("VERCEL_GIT_COMMIT_SHA") ??
    getEnv("RENDER_GIT_COMMIT") ??
    getEnv("RELEASE_SHA") ??
    getEnv("GITHUB_SHA") ??
    getEnv("OBSERVABILITY_RELEASE") ??
    "local"
  );
}

function getEnv(name: string) {
  if (typeof process === "undefined") return undefined;
  return process.env?.[name];
}

function isBrowser() {
  return typeof window !== "undefined";
}

function isTimingEnabled() {
  return getEnv("OPENCOMPANY_TIMING") === "1" || getEnv("OBSERVABILITY_TIMING") === "1";
}

export function isObservabilityEnabled() {
  const raw = getEnv(
    isBrowser() ? "NEXT_PUBLIC_OBSERVABILITY_ENABLED" : "OBSERVABILITY_ENABLED",
  )?.toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function isTrue(value: string | undefined) {
  const raw = value?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

function logTiming(trace: TimingTrace, step: string, durationMs: number, metadata?: LogFields) {
  trace.logger.info("Timing trace", {
    event: "opencompany.timing",
    trace_id: trace.id,
    traceId: trace.id,
    trace: trace.name,
    step,
    durationMs: Math.round(durationMs),
    ...trace.metadata,
    ...metadata,
  });
}

function writeLog(level: LogLevel, line: string) {
  if (level === "debug") {
    console.debug(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  if (level === "error") {
    console.error(line);
    return;
  }
  console.info(line);
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return String(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message),
      ...(value.stack ? { stack: truncateString(value.stack) } : {}),
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (depth >= MAX_DEPTH) return "[truncated]";

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1, seen) ?? null);
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[... ${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items;
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    const output: LogFields = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      if (fieldValue === undefined) continue;
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeValue(fieldValue, depth + 1, seen);
    }

    seen.delete(value);
    return output;
  }

  return String(value);
}

function isPlainRecord(value: unknown): value is LogFields {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      "then" in value &&
      typeof (value as { then?: unknown }).then === "function",
  );
}

function isSensitiveKey(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("cookie") ||
    normalized.includes("authorization") ||
    normalized.includes("privatekey") ||
    normalized.includes("apikey") ||
    normalized.includes("dsn")
  );
}

function truncateString(value: string) {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function newTraceId() {
  const cryptoWithRandomUUID = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoWithRandomUUID?.randomUUID === "function") {
    return cryptoWithRandomUUID.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  return Math.random().toString(16).slice(2, 18).padEnd(16, "0");
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
