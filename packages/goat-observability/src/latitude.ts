import { Latitude } from "@latitude-data/telemetry";
import type { Tracer } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// The AI SDK emits its own OTel spans; "vercelai" is the scope Latitude expects
// for them (rendered as prompt/completion generations in its dashboard).
const LATITUDE_TRACER_SCOPE = "vercelai";

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
  const tracer = client.getTracer(LATITUDE_TRACER_SCOPE, buildContextOptions(context));
  return {
    experimental_telemetry: {
      isEnabled: true,
      functionId: context.name,
      tracer,
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
