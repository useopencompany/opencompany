import { describe, expect, it } from "vitest";
import { BRAIN_INGEST_TRACE_SCHEMA_VERSION, normalizeBrainIngestTrace } from "./brain-ingest-trace";

function trace(budget?: Record<string, unknown>) {
  return {
    schemaVersion: BRAIN_INGEST_TRACE_SCHEMA_VERSION,
    model: "anthropic/claude-sonnet-5",
    steps: 2,
    toolCallCount: 1,
    mutations: 1,
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    finalText: "done",
    toolCalls: [],
    truncatedToolCalls: 0,
    ...(budget ? { budget } : {}),
    createdAt: "2026-07-14T10:00:00.000Z",
  };
}

describe("normalizeBrainIngestTrace", () => {
  it("keeps pre-budget traces compatible", () => {
    expect(normalizeBrainIngestTrace(trace())).not.toHaveProperty("budget");
  });

  it("normalizes the provider-spend budget breakdown", () => {
    expect(
      normalizeBrainIngestTrace(
        trace({
          limitUsdMicros: 500_000,
          stopThresholdUsdMicros: 400_000,
          modelCostUsdMicros: 12_000,
          brainQueryCostUsdMicros: 500,
          webSearchCostUsdMicros: 1_000,
          totalCostUsdMicros: 13_500,
          accountingComplete: true,
          exhausted: false,
        }),
      ),
    ).toMatchObject({
      budget: {
        limitUsdMicros: 500_000,
        stopThresholdUsdMicros: 400_000,
        modelCostUsdMicros: 12_000,
        brainQueryCostUsdMicros: 500,
        webSearchCostUsdMicros: 1_000,
        totalCostUsdMicros: 13_500,
        accountingComplete: true,
        exhausted: false,
      },
    });
  });

  it("normalizes an optional cheap-triage trace", () => {
    expect(
      normalizeBrainIngestTrace({
        ...trace(),
        triage: {
          model: "openai/gpt-5.4-nano",
          decision: "ingest",
          reason: " Contains a durable launch decision. ",
          entityHints: ["  Launch project  ", "", 42, "Ada\nLovelace"],
          usage: { inputTokens: 2_000, outputTokens: 80, totalTokens: 2_080 },
          modelCostUsdMicros: 500,
        },
      }),
    ).toMatchObject({
      triage: {
        model: "openai/gpt-5.4-nano",
        decision: "ingest",
        reason: "Contains a durable launch decision.",
        entityHints: ["Launch project", "Ada Lovelace"],
        usage: { inputTokens: 2_000, outputTokens: 80, totalTokens: 2_080 },
        modelCostUsdMicros: 500,
      },
    });
  });

  it("drops malformed triage traces without breaking the ingest trace", () => {
    expect(
      normalizeBrainIngestTrace({
        ...trace(),
        triage: { decision: "maybe", entityHints: ["Ada"] },
      }),
    ).not.toHaveProperty("triage");
  });

  it("sanitizes malformed budget fields without breaking the trace", () => {
    expect(
      normalizeBrainIngestTrace(trace([] as unknown as Record<string, unknown>)),
    ).not.toHaveProperty("budget");
    expect(
      normalizeBrainIngestTrace(
        trace({
          limitUsdMicros: -1,
          stopThresholdUsdMicros: 1.5,
          modelCostUsdMicros: "bad",
          brainQueryCostUsdMicros: -100,
          webSearchCostUsdMicros: 2.25,
          totalCostUsdMicros: Number.NaN,
          accountingComplete: "true",
          exhausted: 1,
        }),
      ),
    ).toMatchObject({
      budget: {
        limitUsdMicros: 0,
        stopThresholdUsdMicros: 0,
        modelCostUsdMicros: 0,
        brainQueryCostUsdMicros: 0,
        webSearchCostUsdMicros: 0,
        totalCostUsdMicros: 0,
        accountingComplete: false,
        exhausted: false,
      },
    });
  });
});
