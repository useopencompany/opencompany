import { Latitude } from "@latitude-data/telemetry";
import {
  type Context,
  context as otelContext,
  type Span,
  type SpanOptions,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// The AI SDK emits its own OTel spans; "vercelai" is the scope Latitude expects
// for them (rendered as prompt/completion generations in its dashboard).
const LATITUDE_TRACER_SCOPE = "vercelai";
const LATITUDE_CAPTURE_TRACER_SCOPE = "capture";
const LATITUDE_CAPTURE_NAME_ATTRIBUTE = "latitude.capture.name";
const LATITUDE_CAPTURE_ROOT_ATTRIBUTE = "latitude.capture.root";
const LATITUDE_PROVIDER_ATTRIBUTE = "gen_ai.provider.name";
const VERCEL_AI_GATEWAY_PROVIDER = "vercel";

export type LatitudeTelemetryContext = {
  // Capture name shown in Latitude, e.g. "chat-turn" or "brain-ingest".
  name: string;
  // Surface tag, e.g. "chat" | "slack-bot" | "brain-ingest".
  feature: string;
  userId?: string | null | undefined;
  // Groups related traces (chat session, Slack thread, ingest job).
  sessionId?: string | null | undefined;
  tags?: readonly string[];
  metadata?: Record<string, string | number | boolean | null | undefined>;
};

// Structurally compatible with the AI SDK's TelemetrySettings; spread the
// result into streamText/generateText/generateObject options.
export type LatitudeTelemetrySettings = {
  experimental_telemetry?: { isEnabled: boolean; functionId: string; tracer: Tracer };
};

let cached: { client: Latitude | null } | undefined;

export function isLatitudeTelemetryEnabled(): boolean {
  return getLatitudeClient() !== null;
}

/**
 * Returns `{ experimental_telemetry }` wired to a Latitude tracer that stamps
 * the given context (session, user, tags, metadata) onto every span, or `{}`
 * when Latitude is not configured. The tracer belongs to a dedicated provider,
 * so full-content LLM spans go only to Latitude — never to the sanitized OTLP
 * pipeline registered globally by goat-observability.
 */
export function latitudeTelemetry(context: LatitudeTelemetryContext): LatitudeTelemetrySettings {
  const client = getLatitudeClient();
  if (!client) return {};
  const contextOptions = buildContextOptions(context);
  const tracer = createRootedLatitudeTracer(client, context, contextOptions);
  return {
    experimental_telemetry: {
      isEnabled: true,
      functionId: context.name,
      tracer,
    },
  };
}

/**
 * Latitude derives a session's display name and active duration from root
 * spans. Our Latitude provider is intentionally isolated from the app's global
 * OTel provider, so an AI SDK span must not inherit a global request span that
 * Latitude will never receive. Create the same capture boundary Latitude's
 * documented `capture()` helper creates, but on the isolated provider.
 */
function createRootedLatitudeTracer(
  client: Latitude,
  telemetryContext: LatitudeTelemetryContext,
  contextOptions: ReturnType<typeof buildContextOptions>,
): Tracer {
  const modelTracer = client.getTracer(LATITUDE_TRACER_SCOPE, contextOptions);
  const captureTracer = client.getTracer(LATITUDE_CAPTURE_TRACER_SCOPE, contextOptions);
  const startActiveSpan = modelTracer.startActiveSpan.bind(modelTracer) as (
    name: string,
    ...args: unknown[]
  ) => unknown;
  let captureStarted = false;

  return {
    startSpan(name: string, options?: SpanOptions, spanContext?: Context): Span {
      const enrichedOptions = enrichVercelGatewayProvider(options);
      if (captureStarted) return modelTracer.startSpan(name, enrichedOptions, spanContext);

      captureStarted = true;
      const capture = startLatitudeCapture(captureTracer, telemetryContext.name);
      return endCaptureWithSpan(
        modelTracer.startSpan(name, enrichedOptions, capture.context),
        capture.span,
      );
    },
    startActiveSpan<F extends (span: Span) => unknown>(
      name: string,
      arg1: F | SpanOptions,
      arg2?: F | Context,
      arg3?: F,
    ): ReturnType<F> {
      const delegate = (callbackWrapper?: (callback: F) => F) => {
        if (typeof arg1 === "function") {
          const callback = callbackWrapper ? callbackWrapper(arg1) : arg1;
          return startActiveSpan(name, callback) as ReturnType<F>;
        }

        const options = enrichVercelGatewayProvider(arg1);
        if (typeof arg2 === "function") {
          const callback = callbackWrapper ? callbackWrapper(arg2) : arg2;
          return startActiveSpan(name, options, callback) as ReturnType<F>;
        }

        const callback = callbackWrapper ? callbackWrapper(arg3 as F) : arg3;
        return startActiveSpan(name, options, arg2 as Context, callback) as ReturnType<F>;
      };

      if (captureStarted) return delegate();

      captureStarted = true;
      const capture = startLatitudeCapture(captureTracer, telemetryContext.name);
      const wrapCallback = (callback: F) =>
        ((span: Span) => callback(endCaptureWithSpan(span, capture.span))) as F;

      if (typeof arg1 === "function") {
        return startActiveSpan(name, {}, capture.context, wrapCallback(arg1)) as ReturnType<F>;
      }

      const options = enrichVercelGatewayProvider(arg1);
      const callback = typeof arg2 === "function" ? arg2 : (arg3 as F);
      return startActiveSpan(
        name,
        options,
        capture.context,
        wrapCallback(callback),
      ) as ReturnType<F>;
    },
  };
}

function startLatitudeCapture(captureTracer: Tracer, name: string) {
  // A global Next/runner request span may be active here. Remove it so the
  // capture span is a real root in the isolated Latitude trace.
  const parentlessContext = trace.deleteSpan(otelContext.active());
  const span = captureTracer.startSpan(
    name,
    {
      attributes: {
        [LATITUDE_CAPTURE_NAME_ATTRIBUTE]: name,
        [LATITUDE_CAPTURE_ROOT_ATTRIBUTE]: true,
      },
    },
    parentlessContext,
  );
  return {
    span,
    context: trace.setSpan(parentlessContext, span),
  };
}

function endCaptureWithSpan(span: Span, captureSpan: Span): Span {
  let ended = false;
  let proxy: Span;
  proxy = new Proxy(span, {
    get(target, property) {
      if (property === "end") {
        return (endTime?: Parameters<Span["end"]>[0]) => {
          if (ended) {
            target.end(endTime);
            return;
          }
          ended = true;
          try {
            target.end(endTime);
          } finally {
            captureSpan.end(endTime);
          }
        };
      }

      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}

/**
 * The Vercel AI SDK reports AI Gateway calls as provider `gateway`, while
 * Latitude's bundled models.dev pricing catalog calls that provider `vercel`.
 * Add the standard GenAI provider attribute so Latitude can resolve the model
 * and estimate cost from the token usage already emitted by the AI SDK.
 */
function enrichVercelGatewayProvider(options: SpanOptions | undefined): SpanOptions | undefined {
  const attributes = options?.attributes;
  if (
    !attributes ||
    attributes[LATITUDE_PROVIDER_ATTRIBUTE] !== undefined ||
    (attributes["ai.model.provider"] !== "gateway" && attributes["gen_ai.system"] !== "gateway")
  ) {
    return options;
  }
  return {
    ...options,
    attributes: {
      ...attributes,
      [LATITUDE_PROVIDER_ATTRIBUTE]: VERCEL_AI_GATEWAY_PROVIDER,
    },
  };
}

/**
 * Exports buffered spans. Call after each serverless turn (e.g. inside Next's
 * `after()`) and on long-lived process shutdown. Never throws.
 */
export async function flushLatitude(): Promise<void> {
  // Only flush an already-created client; don't initialize just to flush.
  const client = cached?.client ?? null;
  if (!client) return;
  try {
    await client.flush();
  } catch (error) {
    console.warn("[goat-observability] Latitude telemetry flush failed.", error);
  }
}

export function resetLatitudeTelemetryForTests() {
  cached = undefined;
}

function getLatitudeClient(): Latitude | null {
  if (cached !== undefined) return cached.client;
  const config = readConfig();
  if (!config) {
    cached = { client: null };
    return null;
  }
  try {
    // A provider Latitude attaches to but that is never registered globally:
    // without it, `new Latitude()` piggybacks on the global provider and the
    // existing OTLP exporter would also receive full prompt/response spans.
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName }),
    });
    cached = {
      client: new Latitude({
        apiKey: config.apiKey,
        project: config.project,
        tracerProvider: provider,
      }),
    };
  } catch (error) {
    console.warn(
      "[goat-observability] Latitude telemetry init failed; continuing without it.",
      error,
    );
    cached = { client: null };
  }
  return cached.client;
}

function readConfig() {
  if (typeof process === "undefined") return null;
  const disabled = process.env.LATITUDE_TELEMETRY_DISABLED?.trim().toLowerCase();
  if (disabled === "1" || disabled === "true" || disabled === "on" || disabled === "yes") {
    return null;
  }
  const apiKey = process.env.LATITUDE_API_KEY?.trim();
  const project = process.env.LATITUDE_PROJECT_SLUG?.trim();
  if (!apiKey || !project) return null;
  return {
    apiKey,
    project,
    serviceName: process.env.LATITUDE_SERVICE_NAME?.trim() || "opencompany-goat",
  };
}

function buildContextOptions(context: LatitudeTelemetryContext) {
  const env = process.env.VERCEL_ENV?.trim() || process.env.NODE_ENV?.trim() || "unknown";
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(context.metadata ?? {})) {
    if (value !== null && value !== undefined) metadata[key] = value;
  }
  return {
    name: context.name,
    tags: [`env:${env}`, `feature:${context.feature}`, ...(context.tags ?? [])],
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  };
}
