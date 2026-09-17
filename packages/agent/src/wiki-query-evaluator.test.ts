import { beforeEach, describe, expect, it, vi } from "vitest";

const evaluate = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  experimental_evaluate: evaluate,
  createGateway: () => ({ evaluationModel: () => "jev" }),
}));

import { createWikiQueryEvaluator } from "./wiki-query-evaluator";

describe("wiki query evaluator", () => {
  beforeEach(() => evaluate.mockReset());

  it("identifies every candidate explicitly and disables retries", async () => {
    evaluate.mockResolvedValue({
      answers: { candidate_0: { probability: 0.9 }, candidate_1: { probability: 0.02 } },
      usage: { inputTokens: 10 },
      providerMetadata: { gateway: { cost: "0.000001" } },
    });
    const result = await createWikiQueryEvaluator("test-key")({
      question: "Testing?",
      stage: "navigate",
      candidates: [
        { path: "engineering/tests", title: "Tests" },
        { path: "marketing/video", title: "Video" },
      ],
      signal: AbortSignal.timeout(1000),
    });
    expect(result.probabilities).toEqual([0.9, 0.02]);
    const call = evaluate.mock.calls[0]![0];
    expect(call.questions.candidate_1.instructions).toContain("marketing/video");
    expect(call.questions.candidate_1.instructions).toContain("Video");
    expect(call.maxRetries).toBe(0);
    expect(call.providerOptions.gateway.zeroDataRetention).toBe(true);
  });

  it("does not leak provider errors or proceed without usage accounting", async () => {
    const input = {
      question: "Testing?",
      stage: "navigate" as const,
      candidates: [],
      signal: AbortSignal.timeout(1000),
    };
    evaluate.mockRejectedValue(new Error("private request payload"));
    await expect(createWikiQueryEvaluator("test-key")(input)).rejects.toThrow(
      "Wiki query evaluation failed",
    );
    evaluate.mockResolvedValue({ answers: {}, usage: {}, providerMetadata: {} });
    await expect(createWikiQueryEvaluator("test-key")(input)).rejects.toThrow(
      "verify gateway usage",
    );
    evaluate.mockResolvedValue({
      answers: {},
      usage: { inputTokens: 1 },
      providerMetadata: { gateway: { cost: null } },
    });
    await expect(createWikiQueryEvaluator("test-key")(input)).rejects.toThrow(
      "verify gateway usage",
    );
  });
});
