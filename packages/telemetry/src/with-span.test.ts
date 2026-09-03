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

  it("adds sanitized upstream diagnostics from an error cause", async () => {
    vi.stubEnv("OPENCOMPANY_OBSERVABILITY_ENABLED", "true");
    const upstreamError = Object.assign(new Error("GitHub artifact request was rate limited."), {
      upstreamService: "github",
      upstreamOperation: "resolve_commit",
      upstreamStatus: 403,
      upstreamDurationMs: 9,
      failureKind: "rate_limit",
      rateLimitLimit: 60,
      rateLimitRemaining: 0,
      rateLimitReset: 1788422400,
      rateLimitResource: "core",
      retryAfterSeconds: 42,
      upstreamRequestId: "ABCD:1234:5678:90AB",
      unsafeDiagnostic: "token=do-not-expose",
    });

    await expect(
      withSpan("goat.test", undefined, async () => {
        throw new Error("Couldn't read that plugin right now.", { cause: upstreamError });
      }),
    ).rejects.toThrow("Couldn't read that plugin right now.");

    await provider.forceFlush();
    const span = exporter.getFinishedSpans()[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes).toMatchObject({
      "goat.outcome": "failure",
      "goat.failure_category": "integration",
      "goat.upstream_service": "github",
      "goat.upstream_operation": "resolve_commit",
      "goat.upstream_status": 403,
      "goat.upstream_duration_ms": 9,
      "goat.upstream_failure_kind": "rate_limit",
      "goat.rate_limit_limit": 60,
      "goat.rate_limit_remaining": 0,
      "goat.rate_limit_reset": 1788422400,
      "goat.rate_limit_resource": "core",
      "goat.retry_after_seconds": 42,
      "goat.upstream_request_id": "ABCD:1234:5678:90AB",
    });
    expect(JSON.stringify(span?.attributes)).not.toContain("do-not-expose");
  });
});
