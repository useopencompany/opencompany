import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";
import { normalizeModelUsage } from "./usage";

describe("normalizeModelUsage", () => {
  it("keeps cache read/write input buckets and output detail buckets", () => {
    const usage = normalizeModelUsage({
      inputTokens: 100,
      inputTokenDetails: {
        noCacheTokens: 60,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
      },
      outputTokens: 40,
      outputTokenDetails: {
        textTokens: 35,
        reasoningTokens: 5,
      },
      totalTokens: 140,
      raw: { prompt_tokens: 100 },
    } satisfies LanguageModelUsage);

    expect(usage).toEqual({
      inputTokens: 100,
      inputNoCacheTokens: 60,
      inputCacheReadTokens: 30,
      inputCacheWriteTokens: 10,
      outputTokens: 40,
      outputTextTokens: 35,
      outputReasoningTokens: 5,
      totalTokens: 140,
      rawUsage: { prompt_tokens: 100 },
    });
  });

  it("derives normal token buckets when provider details are absent", () => {
    const usage = normalizeModelUsage({
      inputTokens: 100,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: 25,
        cacheWriteTokens: undefined,
      },
      outputTokens: 50,
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: 20,
      },
      totalTokens: undefined,
    } satisfies LanguageModelUsage);

    expect(usage.inputNoCacheTokens).toBe(75);
    expect(usage.outputTextTokens).toBe(30);
    expect(usage.totalTokens).toBe(150);
  });
});
