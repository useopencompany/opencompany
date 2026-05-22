import { describe, expect, it } from "vitest";
import {
  calculateHostedToolUsageCost,
  calculateModelUsageCost,
  calculatePlatformFeeUsdMicros,
  recordWorkspaceUsageDebit,
} from ".";

describe("calculateModelUsageCost", () => {
  it("prices OpenAI uncached, cached read, cache write, and output buckets", () => {
    const cost = calculateModelUsageCost({
      modelName: "openai/gpt-5.4-mini",
      inputTokens: 4_000,
      inputNoCacheTokens: 1_000,
      inputCacheReadTokens: 2_000,
      inputCacheWriteTokens: 1_000,
      outputTokens: 500,
    });

    expect(cost.providerCostUsdMicros).toBe(3_900);
    expect(cost.platformFeeUsdMicros).toBe(390);
    expect(cost.totalCostUsdMicros).toBe(4_290);
  });

  it("prices Anthropic cache writes at the prompt-cache write rate", () => {
    const cost = calculateModelUsageCost({
      modelName: "anthropic/claude-sonnet-4.6",
      inputTokens: 2_000,
      inputNoCacheTokens: 0,
      inputCacheReadTokens: 1_000,
      inputCacheWriteTokens: 1_000,
      outputTokens: 1_000,
    });

    expect(cost.providerCostUsdMicros).toBe(19_050);
    expect(cost.platformFeeUsdMicros).toBe(1_905);
  });

  it("bills output reasoning tokens as output tokens", () => {
    const cost = calculateModelUsageCost({
      modelName: "openai/gpt-5.4",
      inputTokens: 0,
      inputNoCacheTokens: 0,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 1_000,
    });

    expect(cost.providerCostUsdMicros).toBe(15_000);
  });

  it("applies GPT-5.4 long-context uplift when input exceeds the threshold", () => {
    const cost = calculateModelUsageCost({
      modelName: "openai/gpt-5.4",
      inputTokens: 272_001,
      inputNoCacheTokens: 1_000,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 1_000,
    });

    expect(cost.providerCostUsdMicros).toBe(27_500);
    expect(cost.costBasis.longContextApplied).toBe(true);
  });

  it("does not guess prices for unknown models", () => {
    const cost = calculateModelUsageCost({
      modelName: "unknown/model",
      inputTokens: 1_000,
      inputNoCacheTokens: 1_000,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 1_000,
    });

    expect(cost).toMatchObject({
      billable: false,
      providerCostUsdMicros: 0,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 0,
    });
  });

  it("rounds fractional micro-dollar costs deterministically", () => {
    const cost = calculateModelUsageCost({
      modelName: "openai/gpt-5.4-mini",
      inputTokens: 1,
      inputNoCacheTokens: 0,
      inputCacheReadTokens: 1,
      inputCacheWriteTokens: 0,
      outputTokens: 0,
    });

    expect(cost.providerCostUsdMicros).toBe(0);
  });
});

describe("fees and hosted tools", () => {
  it("adds a 10% platform fee", () => {
    expect(calculatePlatformFeeUsdMicros(12_345)).toBe(1_235);
  });

  it("prices hosted tools from provider-reported micros plus platform fee", () => {
    expect(
      calculateHostedToolUsageCost({
        provider: "exa",
        operation: "search",
        providerCostUsdMicros: 7_000,
      }),
    ).toMatchObject({
      providerCostUsdMicros: 7_000,
      platformFeeUsdMicros: 700,
      totalCostUsdMicros: 7_700,
    });
  });
});

describe("recordWorkspaceUsageDebit", () => {
  it("reports duplicate usage debits without applying a second charge", async () => {
    const executeRows = [[{ ledgerId: 1, balanceUsdMicros: 92_300 }], []];
    const db = {
      execute: async () => ({ rows: executeRows.shift() ?? [] }),
    };
    const input = {
      db,
      sessionId: "ses_123",
      messageId: "msg_123",
      modelUsageId: 1,
      source: "model_usage" as const,
      providerCostUsdMicros: 7_000,
      platformFeeUsdMicros: 700,
      totalCostUsdMicros: 7_700,
      costBasis: { kind: "model_usage" },
    };

    await expect(recordWorkspaceUsageDebit(input)).resolves.toEqual({
      ok: true,
      ledgerId: 1,
      balanceUsdMicros: 92_300,
    });
    await expect(recordWorkspaceUsageDebit(input)).resolves.toEqual({
      ok: false,
      reason: "duplicate_or_missing_session",
    });
  });
});
