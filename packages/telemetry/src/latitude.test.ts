import { context, TraceFlags, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  flushLatitude,
  isLatitudeTelemetryEnabled,
  latitudeTelemetry,
  resetLatitudeTelemetryForTests,
} from "./latitude";

const ENV_KEYS = [
  "LATITUDE_API_KEY",
  "LATITUDE_PROJECT_SLUG",
  "LATITUDE_TELEMETRY_DISABLED",
  "LATITUDE_SERVICE_NAME",
] as const;

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetLatitudeTelemetryForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetLatitudeTelemetryForTests();
});

describe("latitudeTelemetry", () => {
  it("is a no-op when env vars are unset", () => {
    expect(isLatitudeTelemetryEnabled()).toBe(false);
    expect(latitudeTelemetry({ name: "chat-turn", feature: "chat" })).toEqual({});
  });

  it("is a no-op when only the api key is set", () => {
    process.env.LATITUDE_API_KEY = "lat_test";
    expect(latitudeTelemetry({ name: "chat-turn", feature: "chat" })).toEqual({});
  });

  it("respects the kill switch", () => {
    process.env.LATITUDE_API_KEY = "lat_test";
    process.env.LATITUDE_PROJECT_SLUG = "opencompany-test";
    process.env.LATITUDE_TELEMETRY_DISABLED = "1";
    expect(isLatitudeTelemetryEnabled()).toBe(false);
    expect(latitudeTelemetry({ name: "chat-turn", feature: "chat" })).toEqual({});
  });

  it("returns enabled telemetry settings with a tracer when configured", () => {
    process.env.LATITUDE_API_KEY = "lat_test";
    process.env.LATITUDE_PROJECT_SLUG = "opencompany-test";
    const settings = latitudeTelemetry({
      name: "chat-turn",
      feature: "chat",
      userId: "user_123",
      sessionId: "session_abc",
      metadata: { model: "anthropic/claude-sonnet-4.6", skipped: null },
    });
    expect(settings.experimental_telemetry?.isEnabled).toBe(true);
    expect(settings.experimental_telemetry?.functionId).toBe("chat-turn");
    expect(typeof settings.experimental_telemetry?.tracer.startSpan).toBe("function");
    expect(typeof settings.experimental_telemetry?.tracer.startActiveSpan).toBe("function");

    const externalSpan = trace.wrapSpanContext({
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      traceFlags: TraceFlags.SAMPLED,
    });
    const span = context.with(
      trace.setSpan(context.active(), externalSpan),
      () =>
        settings.experimental_telemetry?.tracer.startSpan("ai.generateText", {
          attributes: {
            "ai.model.provider": "gateway",
            "ai.model.id": "anthropic/claude-sonnet-4.6",
          },
        }) as
          | {
              attributes?: Record<string, unknown>;
              parentSpanContext?: { traceId: string };
              spanContext(): { traceId: string };
              end(): void;
            }
          | undefined,
    );
    expect(span?.attributes).toMatchObject({
      "latitude.tags": '["env:test","feature:chat"]',
      "latitude.metadata": '{"model":"anthropic/claude-sonnet-4.6"}',
      "session.id": "session_abc",
      "user.id": "user_123",
      "gen_ai.provider.name": "vercel",
    });
    // The first AI SDK span is parented to an isolated Latitude capture root,
    // not to the global app/request span that Latitude never exports.
    expect(span?.parentSpanContext?.traceId).toBe(span?.spanContext().traceId);
    expect(span?.parentSpanContext?.traceId).not.toBe(externalSpan.spanContext().traceId);
    span?.end();

    const modelSpan = latitudeTelemetry({
      name: "chat-turn",
      feature: "chat",
    }).experimental_telemetry?.tracer.startSpan("ai.generateText.doGenerate", {
      attributes: {
        "gen_ai.system": "gateway",
        "gen_ai.request.model": "anthropic/claude-sonnet-4.6",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20,
      },
    }) as { attributes?: Record<string, unknown>; end(): void } | undefined;
    expect(modelSpan?.attributes?.["gen_ai.provider.name"]).toBe("vercel");
    modelSpan?.end();
  });

  it("creates the capture boundary through the AI SDK startActiveSpan path", () => {
    process.env.LATITUDE_API_KEY = "lat_test";
    process.env.LATITUDE_PROJECT_SLUG = "opencompany-test";
    const tracer = latitudeTelemetry({
      name: "brain-ingest",
      feature: "brain-ingest",
      sessionId: "job_123",
    }).experimental_telemetry?.tracer;
    const externalSpan = trace.wrapSpanContext({
      traceId: "3".repeat(32),
      spanId: "4".repeat(16),
      traceFlags: TraceFlags.SAMPLED,
    });

    const span = context.with(trace.setSpan(context.active(), externalSpan), () =>
      tracer?.startActiveSpan(
        "ai.streamText",
        {
          attributes: {
            "ai.model.provider": "gateway",
            "ai.model.id": "anthropic/claude-sonnet-4.6",
          },
        },
        (activeSpan) => activeSpan,
      ),
    ) as
      | {
          attributes?: Record<string, unknown>;
          parentSpanContext?: { traceId: string };
          spanContext(): { traceId: string };
          end(): void;
        }
      | undefined;

    expect(span?.attributes).toMatchObject({
      "session.id": "job_123",
      "gen_ai.provider.name": "vercel",
    });
    expect(span?.parentSpanContext?.traceId).toBe(span?.spanContext().traceId);
    expect(span?.parentSpanContext?.traceId).not.toBe(externalSpan.spanContext().traceId);
    span?.end();
  });

  it("does not register the Latitude provider globally", async () => {
    process.env.LATITUDE_API_KEY = "lat_test";
    process.env.LATITUDE_PROJECT_SLUG = "opencompany-test";
    latitudeTelemetry({ name: "chat-turn", feature: "chat" });
    const { trace } = await import("@opentelemetry/api");
    // The global tracer provider must stay untouched (proxy with no delegate),
    // otherwise full-content spans could leak into the shared OTLP pipeline.
    const globalTracer = trace.getTracerProvider();
    expect(globalTracer.constructor.name).toBe("ProxyTracerProvider");
  });
});

describe("flushLatitude", () => {
  it("resolves without a client", async () => {
    await expect(flushLatitude()).resolves.toBeUndefined();
  });

  it("resolves with an idle client", async () => {
    process.env.LATITUDE_API_KEY = "lat_test";
    process.env.LATITUDE_PROJECT_SLUG = "opencompany-test";
    latitudeTelemetry({ name: "chat-turn", feature: "chat" });
    await expect(flushLatitude()).resolves.toBeUndefined();
  });
});
