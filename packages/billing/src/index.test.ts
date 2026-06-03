import { describe, expect, it } from "vitest";
import {
  calculateHostedToolUsageCost,
  calculateModelUsageCost,
  calculatePlatformFeeUsdMicros,
  calculateSandboxUsageCost,
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

  it.each([
    ["openai/gpt-5.2-codex", 17_675],
    ["openai/gpt-5.4-nano", 1_670],
    ["anthropic/claude-opus-4.7", 36_750],
    ["anthropic/claude-opus-4.8", 36_750],
    ["google/gemini-3-flash", 4_050],
    ["google/gemini-3.1-flash-lite-preview", 2_030],
    ["deepseek/deepseek-v4-flash", 563],
    ["mistral/mistral-medium-3.5", 10_500],
    ["minimax/minimax-m3", 3_720],
    ["minimax/minimax-m2.7", 1_940],
    ["minimax/minimax-m2.7-highspeed", 3_440],
    ["minimax/minimax-m2.5", 1_630],
    ["minimax/minimax-m2.5-highspeed", 3_410],
    ["minimax/minimax-m2.1", 1_910],
    ["minimax/minimax-m2.1-lightning", 1_910],
    ["minimax/minimax-m2", 1_910],
    ["moonshotai/kimi-k2.6", 6_060],
    ["moonshotai/kimi-k2.5", 3_900],
    ["moonshotai/kimi-k2-thinking", 3_850],
    ["moonshotai/kimi-k2-thinking-turbo", 10_450],
    ["moonshotai/kimi-k2-turbo", 10_450],
    ["moonshotai/kimi-k2", 3_440],
    ["xai/grok-4.3", 5_200],
    ["xai/grok-4.20-reasoning", 5_200],
    ["xai/grok-4.20-non-reasoning", 5_200],
    ["xai/grok-4.1-fast-reasoning", 950],
    ["xai/grok-4.1-fast-non-reasoning", 950],
    ["xai/grok-build-0.1", 4_200],
    ["zai/glm-5.1", 7_460],
    ["zai/glm-5-turbo", 6_640],
    ["zai/glm-5v-turbo", 6_640],
  ])("prices %s from Vercel AI Gateway published rates", (modelName, expectedProviderCost) => {
    const cost = calculateModelUsageCost({
      modelName,
      inputTokens: 4_000,
      inputNoCacheTokens: 1_000,
      inputCacheReadTokens: 1_000,
      inputCacheWriteTokens: 1_000,
      outputTokens: 1_000,
    });

    expect(cost.providerCostUsdMicros).toBe(expectedProviderCost);
    expect(cost.billable).toBe(true);
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

  it("applies xAI long-context tiers when input exceeds the threshold", () => {
    const cost = calculateModelUsageCost({
      modelName: "xai/grok-4.3",
      inputTokens: 200_002,
      inputNoCacheTokens: 1_000,
      inputCacheReadTokens: 1_000,
      inputCacheWriteTokens: 0,
      outputTokens: 1_000,
    });

    expect(cost.providerCostUsdMicros).toBe(7_900);
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

describe("calculateSandboxUsageCost", () => {
  it("prices vCPU-seconds + RAM-GiB-seconds plus the platform fee", () => {
    // 60s on the base allocation (2 vCPU, 512 MiB = 0.5 GiB):
    //   vCPU: 60 * 2 * 14   = 1680
    //   RAM:  60 * 0.5 * 4.5 = 135
    const cost = calculateSandboxUsageCost({
      template: "amp",
      vcpu: 2,
      ramMiB: 512,
      activeMs: 60_000,
    });

    expect(cost.providerCostUsdMicros).toBe(1_815);
    expect(cost.platformFeeUsdMicros).toBe(182);
    expect(cost.totalCostUsdMicros).toBe(1_997);
    expect(cost.billable).toBe(true);
    expect(cost.costBasis).toMatchObject({
      kind: "sandbox_usage",
      template: "amp",
      vcpu: 2,
      ramMiB: 512,
      activeMs: 60_000,
    });
  });

  it("is not billable for a zero-duration window", () => {
    const cost = calculateSandboxUsageCost({
      template: null,
      vcpu: 2,
      ramMiB: 512,
      activeMs: 0,
    });

    expect(cost.providerCostUsdMicros).toBe(0);
    expect(cost.totalCostUsdMicros).toBe(0);
    expect(cost.billable).toBe(false);
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

  it("records a sandbox_usage debit against the ledger", async () => {
    let captured: unknown;
    const db = {
      execute: async (query: unknown) => {
        captured = query;
        return { rows: [{ ledgerId: 9, balanceUsdMicros: 88_003 }] };
      },
    };

    await expect(
      recordWorkspaceUsageDebit({
        db,
        sessionId: "ses_123",
        messageId: "msg_123",
        sandboxUsageId: 4,
        source: "sandbox_usage",
        providerCostUsdMicros: 1_815,
        platformFeeUsdMicros: 182,
        totalCostUsdMicros: 1_997,
        costBasis: { kind: "sandbox_usage" },
      }),
    ).resolves.toEqual({ ok: true, ledgerId: 9, balanceUsdMicros: 88_003 });
    expect(captured).toBeDefined();
  });
});
