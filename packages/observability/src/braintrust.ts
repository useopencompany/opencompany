import {
  type Logger as BraintrustLogger,
  currentSpan,
  flush,
  initLogger,
  type Span,
  type StartSpanArgs,
  setMaskingFunction,
  traced,
  wrapAISDK,
} from "braintrust";
import { createLogger, type LogFields } from ".";

type BraintrustTraceInput = {
  name: string;
  type?: StartSpanArgs["type"];
  input?: unknown;
  output?: unknown;
  metadata?: LogFields;
  metrics?: LogFields;
  tags?: string[];
};

const logger = createLogger({ service: "opencompany-braintrust", runtime: "server" });
const DEFAULT_PROJECT_NAME = "OpenCompany Runner";

let braintrustLogger: BraintrustLogger<true> | null | undefined;
let maskingConfigured = false;
let loggedMissingApiKey = false;
let loggedInitializationFailure = false;
const wrappedAISDKs = new WeakMap<object, unknown>();

export type BraintrustSpan = Span;

export function isBraintrustTracingEnabled() {
  return isExplicitlyEnabled() && Boolean(getEnv("BRAINTRUST_API_KEY")?.trim());
}

export function getBraintrustLogger() {
  if (braintrustLogger !== undefined) return braintrustLogger;

  if (!isExplicitlyEnabled()) {
    braintrustLogger = null;
    return braintrustLogger;
  }

  const apiKey = getEnv("BRAINTRUST_API_KEY")?.trim();
  if (!apiKey) {
    if (!loggedMissingApiKey) {
      loggedMissingApiKey = true;
      logger.warn("Skipped Braintrust tracing setup", {
        event: "opencompany.braintrust_skipped",
        reason: "missing_api_key",
      });
    }
    braintrustLogger = null;
    return braintrustLogger;
  }

  try {
    configureMasking();
    const projectId = getEnv("BRAINTRUST_PROJECT_ID")?.trim();
    const projectName = getEnv("BRAINTRUST_PROJECT_NAME")?.trim() || DEFAULT_PROJECT_NAME;
    braintrustLogger = initLogger({
      ...(projectId ? { projectId } : { projectName }),
      apiKey,
      // Do not register this logger as the global current logger. We always open the root span
      // explicitly via `traceBraintrust` (Logger.traced), which sets the span as current in the
      // AsyncLocalStorage context for its callback. Nested `traceBraintrustStep` / `currentSpan`
      // calls then attach correctly. Setting this true would also auto-parent stray spans created
      // outside a root trace, which we intentionally avoid.
      setCurrent: false,
    });
    logger.info("Registered Braintrust tracing", {
      event: "opencompany.braintrust_registered",
      ...(projectId ? { project_id: projectId } : { project_name: projectName }),
    });
    return braintrustLogger;
  } catch (error) {
    if (!loggedInitializationFailure) {
      loggedInitializationFailure = true;
      logger.warn("Braintrust tracing setup failed", {
        event: "opencompany.braintrust_setup_failed",
        error,
      });
    }
    braintrustLogger = null;
    return braintrustLogger;
  }
}

export function getBraintrustAISDK<T extends object>(aiSDK: T): T {
  if (!getBraintrustLogger()) return aiSDK;

  const existing = wrappedAISDKs.get(aiSDK);
  if (existing) return existing as T;

  const wrapped = wrapAISDK(aiSDK);
  wrappedAISDKs.set(aiSDK, wrapped);
  return wrapped;
}

export async function traceBraintrust<T>(
  input: BraintrustTraceInput,
  run: (span: BraintrustSpan | undefined) => Promise<T>,
): Promise<T> {
  const project = getBraintrustLogger();
  if (!project) return run(undefined);

  return project.traced(
    async (span) => {
      return run(span);
    },
    {
      name: input.name,
      type: input.type ?? "task",
      ...eventFromTraceInput(input),
    },
  );
}

export async function traceBraintrustStep<T>(
  name: string,
  run: (span: BraintrustSpan | undefined) => Promise<T>,
  metadata?: LogFields,
  options?: Omit<BraintrustTraceInput, "name" | "metadata">,
): Promise<T> {
  if (!getBraintrustLogger()) return run(undefined);

  return traced(
    async (span) => {
      if (metadata) span.log({ metadata });
      return run(span);
    },
    {
      name,
      type: options?.type ?? "function",
      ...eventFromTraceInput({
        name,
        ...(metadata ? { metadata } : {}),
        ...options,
      }),
    },
  );
}

export function logBraintrustSpan(span: BraintrustSpan | undefined, fields: LogFields) {
  if (!span || !getBraintrustLogger()) return;

  try {
    span.log(fields);
  } catch (error) {
    logger.warn("Braintrust span log failed", {
      event: "opencompany.braintrust_span_log_failed",
      error,
    });
  }
}

export function logBraintrustCurrentSpan(fields: LogFields) {
  if (!getBraintrustLogger()) return;

  try {
    currentSpan().log(fields);
  } catch (error) {
    logger.warn("Braintrust current span log failed", {
      event: "opencompany.braintrust_current_span_log_failed",
      error,
    });
  }
}

export async function flushBraintrust() {
  if (!getBraintrustLogger()) return;

  try {
    await flush();
  } catch (error) {
    logger.warn("Braintrust flush failed", {
      event: "opencompany.braintrust_flush_failed",
      error,
    });
  }
}

export function maskBraintrustValue(value: unknown): unknown {
  return maskValue(value, new WeakSet<object>());
}

function configureMasking() {
  if (maskingConfigured) return;
  setMaskingFunction(maskBraintrustValue);
  maskingConfigured = true;
}

function eventFromTraceInput(input: BraintrustTraceInput) {
  const event = {
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
  };
  return Object.keys(event).length > 0 ? { event } : {};
}

function isExplicitlyEnabled() {
  const raw = getEnv("BRAINTRUST_ENABLED")?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function getEnv(name: string) {
  if (typeof process === "undefined") return undefined;
  return process.env?.[name];
}

function maskValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskString(value.message),
      ...(value.stack ? { stack: maskString(value.stack) } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((item) => maskValue(item, seen));
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return "[circular]";

  seen.add(value);
  const masked: LogFields = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    // Only redact secret-like *string* values. Numeric/boolean values are never credentials, and
    // redacting them to "[redacted]" breaks Braintrust's schema: metric keys such as `tokens`,
    // `prompt_tokens`, `completion_tokens`, and `time_to_first_token` match the "token" rule but
    // must stay numbers, or the API rejects the whole row (400) and the span never closes.
    if (isSensitiveKey(key) && !isNonRedactableValue(fieldValue)) {
      masked[key] = "[redacted]";
    } else {
      masked[key] = maskValue(fieldValue, seen);
    }
  }
  seen.delete(value);
  return masked;
}

function isNonRedactableValue(value: unknown) {
  return typeof value === "number" || typeof value === "boolean" || typeof value === "bigint";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
    normalized.includes("credential") ||
    normalized.includes("dsn")
  );
}

function maskString(value: string) {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(api[_-]?key|password|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted]");
}
