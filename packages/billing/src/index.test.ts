import { describe, expect, it } from "vitest";
import {
  calculateBrowserbaseSessionCost,
  calculateHostedToolUsageCost,
  calculateModelUsageCost,
  calculatePlatformFeeUsdMicros,
  calculateSandboxUsageCost,
  checkWorkspaceRunAllowance,
  getDayResetAtUtc,
  getDayStartUtc,
  getUsageSpendSinceUsdMicros,
  getWeekResetAtUtc,
  getWeekStartUtc,
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
    expect(cost.platformFeeUsdMicros).toBe(0);
    expect(cost.totalCostUsdMicros).toBe(3_900);
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
    expect(cost.platformFeeUsdMicros).toBe(0);
  });

  it.each([
    ["openai/gpt-6-astra", 73_500],
    ["openai/gpt-5.6-sol", 41_750],
    ["openai/gpt-5.6-terra", 20_875],
    ["openai/gpt-5.6-luna", 8_350],
    ["openai/gpt-5.5", 40_500],
    ["openai/gpt-5.2-codex", 17_675],
    ["openai/gpt-5.4-nano", 1_670],
    ["anthropic/claude-sonnet-5", 22_050],
    ["anthropic/claude-opus-4.7", 36_750],
    ["anthropic/claude-opus-4.8", 36_750],
    ["anthropic/claude-fable-5", 73_500],
    ["google/gemini-3-flash", 4_050],
    ["google/gemini-3.1-flash-lite-preview", 2_030],
    ["google/gemini-3.1-flash-lite", 2_030],
    ["deepseek/deepseek-v4-pro", 1_744],
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
    ["moonshotai/kimi-k3", 21_300],
    ["moonshotai/kimi-k2.6", 6_060],
    ["moonshotai/kimi-k2.5", 3_900],
    ["moonshotai/kimi-k2-thinking", 3_850],
    ["moonshotai/kimi-k2-thinking-turbo", 10_450],
    ["moonshotai/kimi-k2-turbo", 10_450],
    ["moonshotai/kimi-k2", 3_440],
    ["xai/grok-4.6", 10_500],
    ["xai/grok-4.3", 5_200],
    ["xai/grok-4.20-reasoning", 5_200],
    ["xai/grok-4.20-non-reasoning", 5_200],
    ["xai/grok-4.1-fast-reasoning", 950],
    ["xai/grok-4.1-fast-non-reasoning", 950],
    ["xai/grok-build-0.1", 4_200],
    ["zai/glm-5.1", 7_460],
    ["zai/glm-5.2", 7_460],
    ["zai/glm-5-turbo", 6_640],
    ["zai/glm-5v-turbo", 6_640],
  ])("prices %s from published provider rates", (modelName, expectedProviderCost) => {
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

  it("applies GPT-6 Astra long-context pricing above 272K input tokens", () => {
    const cost = calculateModelUsageCost({
      modelName: "openai/gpt-6-astra",
      inputTokens: 272_001,
      inputNoCacheTokens: 1_000,
      inputCacheReadTokens: 1_000,
      inputCacheWriteTokens: 1_000,
      outputTokens: 1_000,
    });

    expect(cost.providerCostUsdMicros).toBe(122_000);
    expect(cost.costBasis).toMatchObject({
      longContextApplied: true,
      ratesUsdMicrosPerMillion: {
        inputNoCache: 20_000_000,
        inputCacheRead: 2_000_000,
        inputCacheWrite: 25_000_000,
        output: 75_000_000,
      },
    });
  });

  it("applies xAI long-context tiers when input reaches the threshold", () => {
    const shortContextCost = calculateModelUsageCost({
      modelName: "xai/grok-4.6",
      inputTokens: 199_999,
      inputNoCacheTokens: 1_000,
      inputCacheReadTokens: 1_000,
      inputCacheWriteTokens: 0,
      outputTokens: 1_000,
    });
    const cost = calculateModelUsageCost({
      modelName: "xai/grok-4.6",
      inputTokens: 200_000,
      inputNoCacheTokens: 1_000,
      inputCacheReadTokens: 1_000,
      inputCacheWriteTokens: 0,
      outputTokens: 1_000,
    });

    expect(shortContextCost.providerCostUsdMicros).toBe(8_500);
    expect(shortContextCost.costBasis.longContextApplied).toBe(false);
    expect(cost.providerCostUsdMicros).toBe(17_000);
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

  it("does not guess static prices for variable-priced router models", () => {
    const cost = calculateModelUsageCost({
      modelName: "openrouter/fusion",
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
      costBasis: {
        reason: "variable_pricing",
      },
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
  it("does not add a platform fee", () => {
    expect(calculatePlatformFeeUsdMicros(12_345)).toBe(0);
  });

  it("prices hosted tools from provider-reported micros at cost", () => {
    expect(
      calculateHostedToolUsageCost({
        provider: "exa",
        operation: "search",
        providerCostUsdMicros: 7_000,
      }),
    ).toMatchObject({
      providerCostUsdMicros: 7_000,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 7_000,
      costBasis: {
        costSource: "provider_reported",
        pricingVersion: "provider-reported.2026-05-22",
      },
    });
  });

  it("labels platform-priced tool usage with the model catalog version in the cost basis", () => {
    // Tools whose provider cannot price gateway models (opencode, OC-328) compute the
    // provider cost from tokens with MODEL_PRICING; the ledger must not claim that
    // figure was provider-reported.
    expect(
      calculateHostedToolUsageCost({
        provider: "opencode",
        operation: "session",
        providerCostUsdMicros: 11_565,
        costSource: "platform_model_pricing",
      }),
    ).toMatchObject({
      providerCostUsdMicros: 11_565,
      costBasis: {
        costSource: "platform_model_pricing",
        pricingVersion: "2026-09-04.standard.1",
      },
    });
  });

  it("labels broker-metered tool usage with the model catalog version in the cost basis", () => {
    // LLM-broker settlement rows: the runner metered the upstream requests itself and
    // priced them from the model catalog, so the catalog version applies.
    expect(
      calculateHostedToolUsageCost({
        provider: "opencode",
        operation: "brokered",
        providerCostUsdMicros: 1_000_000,
        costSource: "broker_metered",
      }),
    ).toMatchObject({
      providerCostUsdMicros: 1_000_000,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 1_000_000,
      costBasis: {
        costSource: "broker_metered",
        pricingVersion: "2026-09-04.standard.1",
      },
    });
  });
});

describe("calculateSandboxUsageCost", () => {
  it("prices vCPU-seconds + RAM-GiB-seconds at cost", () => {
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
    expect(cost.platformFeeUsdMicros).toBe(0);
    expect(cost.totalCostUsdMicros).toBe(1_815);
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

describe("calculateBrowserbaseSessionCost", () => {
  it("prices final provider timing and proxy bytes with Browserbase minimums", () => {
    const cost = calculateBrowserbaseSessionCost({
      durationMs: 15_000,
      proxyBytes: 100_000,
    });

    expect(cost).toMatchObject({
      billable: true,
      providerCostUsdMicros: 14_000,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 14_000,
      costBasis: {
        kind: "sandbox_usage",
        provider: "browserbase",
        durationMs: 15_000,
        billedDurationMs: 60_000,
        proxyBytes: 100_000,
        billedProxyBytes: 1_000_000,
        costsUsdMicros: { browser: 2_000, proxy: 12_000 },
      },
    });
  });

  it("does not invent usage when final provider metrics are empty", () => {
    expect(calculateBrowserbaseSessionCost({ durationMs: 0, proxyBytes: 0 })).toMatchObject({
      billable: false,
      providerCostUsdMicros: 0,
      totalCostUsdMicros: 0,
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

describe("getWeekStartUtc / getWeekResetAtUtc", () => {
  it("returns Monday 00:00 UTC for a midweek timestamp", () => {
    // 2026-06-17 is a Wednesday.
    const start = getWeekStartUtc(new Date("2026-06-17T13:45:30.123Z"));
    expect(start.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("treats Monday as the start of its own week", () => {
    const start = getWeekStartUtc(new Date("2026-06-15T00:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("rolls Sunday back to the preceding Monday", () => {
    // 2026-06-21 is a Sunday.
    const start = getWeekStartUtc(new Date("2026-06-21T23:59:59.000Z"));
    expect(start.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("reset is exactly seven days after the week start", () => {
    const reset = getWeekResetAtUtc(new Date("2026-06-17T13:45:30.123Z"));
    expect(reset.toISOString()).toBe("2026-06-22T00:00:00.000Z");
  });
});

describe("getDayStartUtc / getDayResetAtUtc", () => {
  it("returns midnight UTC for the day containing the timestamp", () => {
    const start = getDayStartUtc(new Date("2026-06-17T13:45:30.123Z"));
    expect(start.toISOString()).toBe("2026-06-17T00:00:00.000Z");
  });

  it("treats midnight UTC as the start of its own day", () => {
    const start = getDayStartUtc(new Date("2026-06-17T00:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-06-17T00:00:00.000Z");
  });

  it("reset is exactly one day after the day start", () => {
    const reset = getDayResetAtUtc(new Date("2026-06-17T13:45:30.123Z"));
    expect(reset.toISOString()).toBe("2026-06-18T00:00:00.000Z");
  });
});

describe("getUsageSpendSinceUsdMicros", () => {
  it("returns the summed magnitude of usage debits", async () => {
    const db = { execute: async () => ({ rows: [{ spendUsdMicros: 1_234_500 }] }) };
    await expect(
      getUsageSpendSinceUsdMicros({
        db,
        workspaceId: "wks_1",
        since: new Date("2026-06-15T00:00:00Z"),
      }),
    ).resolves.toBe(1_234_500);
  });

  it("parses bigint string results and defaults to 0 when empty", async () => {
    const stringDb = { execute: async () => ({ rows: [{ spendUsdMicros: "987650" }] }) };
    await expect(
      getUsageSpendSinceUsdMicros({ db: stringDb, workspaceId: "wks_1", since: new Date() }),
    ).resolves.toBe(987_650);

    const emptyDb = { execute: async () => ({ rows: [] }) };
    await expect(
      getUsageSpendSinceUsdMicros({ db: emptyDb, workspaceId: "wks_1", since: new Date() }),
    ).resolves.toBe(0);
  });
});

describe("checkWorkspaceRunAllowance", () => {
  function dbReturning(row: Record<string, unknown>) {
    return { execute: async () => ({ rows: [row] }) };
  }

  it("allows when balance is positive and no limit is configured", async () => {
    const db = dbReturning({
      balanceUsdMicros: 5_000_000,
      spendLimitEnabled: false,
      weeklySpendLimitUsdMicros: null,
      weeklySpendUsdMicros: 0,
    });
    const result = await checkWorkspaceRunAllowance({ db, workspaceId: "wks_1" });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("blocks with no_balance when balance is zero", async () => {
    const db = dbReturning({
      balanceUsdMicros: 0,
      spendLimitEnabled: false,
      weeklySpendLimitUsdMicros: null,
      weeklySpendUsdMicros: 0,
    });
    const result = await checkWorkspaceRunAllowance({ db, workspaceId: "wks_1" });
    expect(result).toMatchObject({ allowed: false, reason: "no_balance" });
  });

  it("blocks with weekly_limit_reached when spend meets the enabled limit", async () => {
    const db = dbReturning({
      balanceUsdMicros: 5_000_000,
      spendLimitEnabled: true,
      weeklySpendLimitUsdMicros: 2_000_000,
      weeklySpendUsdMicros: 2_000_000,
    });
    const result = await checkWorkspaceRunAllowance({ db, workspaceId: "wks_1" });
    expect(result).toMatchObject({ allowed: false, reason: "weekly_limit_reached" });
  });

  it("does not enforce the limit when spendLimitEnabled is false", async () => {
    const db = dbReturning({
      balanceUsdMicros: 5_000_000,
      spendLimitEnabled: false,
      weeklySpendLimitUsdMicros: 1_000_000,
      weeklySpendUsdMicros: 9_000_000,
    });
    const result = await checkWorkspaceRunAllowance({ db, workspaceId: "wks_1" });
    expect(result.allowed).toBe(true);
  });

  it("prioritizes weekly_limit_reached over no_balance when both apply", async () => {
    const db = dbReturning({
      balanceUsdMicros: 0,
      spendLimitEnabled: true,
      weeklySpendLimitUsdMicros: 1_000_000,
      weeklySpendUsdMicros: 1_500_000,
    });
    const result = await checkWorkspaceRunAllowance({ db, workspaceId: "wks_1" });
    expect(result.reason).toBe("weekly_limit_reached");
  });

  it("allows when spend is below the limit and balance is positive", async () => {
    const db = dbReturning({
      balanceUsdMicros: 3_000_000,
      spendLimitEnabled: true,
      weeklySpendLimitUsdMicros: 2_000_000,
      weeklySpendUsdMicros: 1_999_999,
    });
    const result = await checkWorkspaceRunAllowance({ db, workspaceId: "wks_1" });
    expect(result.allowed).toBe(true);
  });

  it("blocks with daily_limit_reached when daily spend meets the enabled daily limit", async () => {
    const db = dbReturning({
      balanceUsdMicros: 5_000_000,
      spendLimitEnabled: false,
      weeklySpendLimitUsdMicros: null,
      weeklySpendUsdMicros: 0,
      dailySpendLimitEnabled: true,
      dailySpendLimitUsdMicros: 1_000_000,
      dailySpendUsdMicros: 1_000_000,
    });
    const result = await checkWorkspaceRunAllowance({ db, workspaceId: "wks_1" });
    expect(result).toMatchObject({ allowed: false, reason: "daily_limit_reached" });
  });

  it("does not enforce the daily limit when dailySpendLimitEnabled is false", async () => {
    const db = dbReturning({
      balanceUsdMicros: 5_000_000,
      spendLimitEnabled: false,
      weeklySpendLimitUsdMicros: null,
      weeklySpendUsdMicros: 0,
      dailySpendLimitEnabled: false,
      dailySpendLimitUsdMicros: 1_000_000,
      dailySpendUsdMicros: 9_000_000,
    });
    const result = await checkWorkspaceRunAllowance({ db, workspaceId: "wks_1" });
    expect(result.allowed).toBe(true);
  });

  it("prioritizes daily_limit_reached over weekly_limit_reached when both apply", async () => {
    const db = dbReturning({
      balanceUsdMicros: 5_000_000,
      spendLimitEnabled: true,
      weeklySpendLimitUsdMicros: 2_000_000,
      weeklySpendUsdMicros: 2_000_000,
      dailySpendLimitEnabled: true,
      dailySpendLimitUsdMicros: 1_000_000,
      dailySpendUsdMicros: 1_000_000,
    });
    const result = await checkWorkspaceRunAllowance({ db, workspaceId: "wks_1" });
    expect(result.reason).toBe("daily_limit_reached");
  });

  it("allows when daily spend is below the daily limit", async () => {
    const db = dbReturning({
      balanceUsdMicros: 3_000_000,
      spendLimitEnabled: false,
      weeklySpendLimitUsdMicros: null,
      weeklySpendUsdMicros: 0,
      dailySpendLimitEnabled: true,
      dailySpendLimitUsdMicros: 1_000_000,
      dailySpendUsdMicros: 999_999,
    });
    const result = await checkWorkspaceRunAllowance({ db, workspaceId: "wks_1" });
    expect(result.allowed).toBe(true);
    expect(result.dailySpendUsdMicros).toBe(999_999);
  });
});
