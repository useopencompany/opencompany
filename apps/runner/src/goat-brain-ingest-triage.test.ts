import { beforeEach, describe, expect, it, vi } from "vitest";

const aiMock = vi.hoisted(() => ({
  generateObject: vi.fn(),
  createGateway: vi.fn(() => (model: string) => ({ model })),
  jsonSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock("ai", () => ({
  generateObject: aiMock.generateObject,
  createGateway: aiMock.createGateway,
  jsonSchema: aiMock.jsonSchema,
}));

vi.mock("@opencompany/observability/braintrust", () => ({
  getBraintrustAISDK: <T>(sdk: T) => sdk,
}));

import {
  GOAT_BRAIN_INGEST_TRIAGE_MAX_OUTPUT_TOKENS,
  GOAT_BRAIN_INGEST_TRIAGE_MODEL,
  GOAT_BRAIN_INGEST_TRIAGE_SOURCE_BYTES,
  GOAT_BRAIN_INGEST_TRIAGE_SYSTEM_PROMPT,
  runGoatBrainIngestTriage,
  truncateTriageSource,
} from "./goat-brain-ingest-triage";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runGoatBrainIngestTriage", () => {
  it("uses one bounded nano-model structured-output call and prices its usage", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: {
        decision: "ingest",
        reason: "Contains a durable launch decision.",
        entityHints: [" Launch project ", "Acme", "launch project"],
      },
      usage: {
        inputTokens: 2_000,
        outputTokens: 100,
        totalTokens: 2_100,
      },
    });

    const result = await runGoatBrainIngestTriage({
      prompt: "Classify this source.",
      gatewayApiKey: "gw_test",
      userWorkosId: "user_123",
      brainRef: "gbrain_123",
      ingestJobId: "job_123",
    });

    expect(aiMock.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { model: GOAT_BRAIN_INGEST_TRIAGE_MODEL },
        system: GOAT_BRAIN_INGEST_TRIAGE_SYSTEM_PROMPT,
        prompt: "Classify this source.",
        maxOutputTokens: GOAT_BRAIN_INGEST_TRIAGE_MAX_OUTPUT_TOKENS,
        providerOptions: expect.objectContaining({
          openai: expect.objectContaining({ reasoningEffort: "low" }),
          gateway: expect.objectContaining({
            tags: expect.arrayContaining(["feature:brain-ingest", "stage:triage"]),
          }),
        }),
      }),
    );
    expect(result).toEqual({
      model: GOAT_BRAIN_INGEST_TRIAGE_MODEL,
      decision: "ingest",
      reason: "Contains a durable launch decision.",
      entityHints: ["Launch project", "Acme"],
      usage: {
        inputTokens: 2_000,
        outputTokens: 100,
        totalTokens: 2_100,
        cacheReadInputTokens: null,
        cacheWriteInputTokens: null,
      },
      // 2k input @ $0.20/M + 100 output @ $1.25/M.
      modelCostUsdMicros: 525,
    });
  });
});

describe("truncateTriageSource", () => {
  it("keeps both ends of oversized source data within the byte budget", () => {
    const source = `BEGIN-${"🙂".repeat(2_000)}-END`;
    const truncated = truncateTriageSource(source, GOAT_BRAIN_INGEST_TRIAGE_SOURCE_BYTES);

    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(
      GOAT_BRAIN_INGEST_TRIAGE_SOURCE_BYTES,
    );
    expect(truncated.startsWith("BEGIN-")).toBe(true);
    expect(truncated).toContain("[middle truncated for cheap triage]");
    expect(truncated.endsWith("-END")).toBe(true);
    expect(truncated).not.toContain("�");
  });
});
