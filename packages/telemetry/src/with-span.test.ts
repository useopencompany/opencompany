import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
let withSpan: typeof import(".").withSpan;

beforeAll(async () => {
  trace.setGlobalTracerProvider(provider);
  ({ withSpan } = await import("."));
});

afterEach(() => {
  exporter.reset();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

describe("withSpan", () => {
  it("preserves an explicit failure when the callback returns a fallback value", async () => {
    vi.stubEnv("OPENCOMPANY_OBSERVABILITY_ENABLED", "true");

    const value = await withSpan("goat.test", undefined, async (span) => {
      span.fail(new TypeError("database unavailable"));
      return "fallback";
    });

    await provider.forceFlush();
    expect(value).toBe("fallback");
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
