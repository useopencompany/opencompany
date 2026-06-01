import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { type SQLWrapper, sql } from "drizzle-orm";

export const USD_MICROS_PER_CENT = 10_000;
export const USD_MICROS_PER_DOLLAR = 1_000_000;
export const PLATFORM_FEE_BPS = 1000;

const TOKENS_PER_MILLION = 1_000_000;
const GPT_5_4_LONG_CONTEXT_INPUT_TOKEN_THRESHOLD = 272_000;

type PricingProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "mistral"
  | "minimax"
  | "moonshotai"
  | "zai";

type ModelPricing = {
  model: AgentModelId;
  provider: PricingProvider;
  inputUsdMicrosPerMillion: number;
  cachedInputUsdMicrosPerMillion: number;
  cacheWriteUsdMicrosPerMillion: number;
  outputUsdMicrosPerMillion: number;
};

export type UsageCostInput = {
  modelName: string;
  inputTokens: number;
  inputNoCacheTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
};

export type UsageCostResult = {
  billable: boolean;
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  totalCostUsdMicros: number;
  costBasis: Record<string, unknown>;
};

export type WorkspaceUsageDebitInput = {
  db: {
    execute: (query: string | SQLWrapper) => Promise<unknown>;
  };
  sessionId: string;
  messageId?: string | null;
  modelUsageId?: number | null;
  toolUsageId?: number | null;
  source: "model_usage" | "tool_usage";
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  totalCostUsdMicros: number;
  costBasis: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

const MODEL_PRICING: Record<AgentModelId, ModelPricing> = {
  "openai/gpt-5.4-mini": {
    model: "openai/gpt-5.4-mini",
    provider: "openai",
    inputUsdMicrosPerMillion: 750_000,
    cachedInputUsdMicrosPerMillion: 75_000,
    cacheWriteUsdMicrosPerMillion: 750_000,
    outputUsdMicrosPerMillion: 4_500_000,
  },
  "openai/gpt-5.4-nano": {
    model: "openai/gpt-5.4-nano",
    provider: "openai",
    inputUsdMicrosPerMillion: 200_000,
    cachedInputUsdMicrosPerMillion: 20_000,
    cacheWriteUsdMicrosPerMillion: 200_000,
    outputUsdMicrosPerMillion: 1_250_000,
  },
  "openai/gpt-5.4": {
    model: "openai/gpt-5.4",
    provider: "openai",
    inputUsdMicrosPerMillion: 2_500_000,
    cachedInputUsdMicrosPerMillion: 250_000,
    cacheWriteUsdMicrosPerMillion: 2_500_000,
    outputUsdMicrosPerMillion: 15_000_000,
  },
  "openai/gpt-5.2-codex": {
    model: "openai/gpt-5.2-codex",
    provider: "openai",
    inputUsdMicrosPerMillion: 1_750_000,
    cachedInputUsdMicrosPerMillion: 175_000,
    cacheWriteUsdMicrosPerMillion: 1_750_000,
    outputUsdMicrosPerMillion: 14_000_000,
  },
  "anthropic/claude-haiku-4.5": {
    model: "anthropic/claude-haiku-4.5",
    provider: "anthropic",
    inputUsdMicrosPerMillion: 1_000_000,
    cachedInputUsdMicrosPerMillion: 100_000,
    cacheWriteUsdMicrosPerMillion: 1_250_000,
    outputUsdMicrosPerMillion: 5_000_000,
  },
  "anthropic/claude-sonnet-4.6": {
    model: "anthropic/claude-sonnet-4.6",
    provider: "anthropic",
    inputUsdMicrosPerMillion: 3_000_000,
    cachedInputUsdMicrosPerMillion: 300_000,
    cacheWriteUsdMicrosPerMillion: 3_750_000,
    outputUsdMicrosPerMillion: 15_000_000,
  },
  "anthropic/claude-opus-4.7": {
    model: "anthropic/claude-opus-4.7",
    provider: "anthropic",
    inputUsdMicrosPerMillion: 5_000_000,
    cachedInputUsdMicrosPerMillion: 500_000,
    cacheWriteUsdMicrosPerMillion: 6_250_000,
    outputUsdMicrosPerMillion: 25_000_000,
  },
  "anthropic/claude-opus-4.8": {
    model: "anthropic/claude-opus-4.8",
    provider: "anthropic",
    inputUsdMicrosPerMillion: 5_000_000,
    cachedInputUsdMicrosPerMillion: 500_000,
    cacheWriteUsdMicrosPerMillion: 6_250_000,
    outputUsdMicrosPerMillion: 25_000_000,
  },
  "google/gemini-3-flash": {
    model: "google/gemini-3-flash",
    provider: "google",
    inputUsdMicrosPerMillion: 500_000,
    cachedInputUsdMicrosPerMillion: 50_000,
    cacheWriteUsdMicrosPerMillion: 500_000,
    outputUsdMicrosPerMillion: 3_000_000,
  },
  "google/gemini-3.1-flash-lite-preview": {
    model: "google/gemini-3.1-flash-lite-preview",
    provider: "google",
    inputUsdMicrosPerMillion: 250_000,
    cachedInputUsdMicrosPerMillion: 30_000,
    cacheWriteUsdMicrosPerMillion: 250_000,
    outputUsdMicrosPerMillion: 1_500_000,
  },
  "deepseek/deepseek-v4-flash": {
    model: "deepseek/deepseek-v4-flash",
    provider: "deepseek",
    inputUsdMicrosPerMillion: 140_000,
    cachedInputUsdMicrosPerMillion: 2_800,
    cacheWriteUsdMicrosPerMillion: 140_000,
    outputUsdMicrosPerMillion: 280_000,
  },
  "mistral/mistral-medium-3.5": {
    model: "mistral/mistral-medium-3.5",
    provider: "mistral",
    inputUsdMicrosPerMillion: 1_500_000,
    cachedInputUsdMicrosPerMillion: 0,
    cacheWriteUsdMicrosPerMillion: 1_500_000,
    outputUsdMicrosPerMillion: 7_500_000,
  },
  "minimax/minimax-m3": {
    model: "minimax/minimax-m3",
    provider: "minimax",
    inputUsdMicrosPerMillion: 600_000,
    cachedInputUsdMicrosPerMillion: 120_000,
    cacheWriteUsdMicrosPerMillion: 600_000,
    outputUsdMicrosPerMillion: 2_400_000,
  },
  "minimax/minimax-m2.7": {
    model: "minimax/minimax-m2.7",
    provider: "minimax",
    inputUsdMicrosPerMillion: 300_000,
    cachedInputUsdMicrosPerMillion: 60_000,
    cacheWriteUsdMicrosPerMillion: 380_000,
    outputUsdMicrosPerMillion: 1_200_000,
  },
  "minimax/minimax-m2.7-highspeed": {
    model: "minimax/minimax-m2.7-highspeed",
    provider: "minimax",
    inputUsdMicrosPerMillion: 600_000,
    cachedInputUsdMicrosPerMillion: 60_000,
    cacheWriteUsdMicrosPerMillion: 380_000,
    outputUsdMicrosPerMillion: 2_400_000,
  },
  "minimax/minimax-m2.5": {
    model: "minimax/minimax-m2.5",
    provider: "minimax",
    inputUsdMicrosPerMillion: 270_000,
    cachedInputUsdMicrosPerMillion: 30_000,
    cacheWriteUsdMicrosPerMillion: 380_000,
    outputUsdMicrosPerMillion: 950_000,
  },
  "minimax/minimax-m2.5-highspeed": {
    model: "minimax/minimax-m2.5-highspeed",
    provider: "minimax",
    inputUsdMicrosPerMillion: 600_000,
    cachedInputUsdMicrosPerMillion: 30_000,
    cacheWriteUsdMicrosPerMillion: 380_000,
    outputUsdMicrosPerMillion: 2_400_000,
  },
  "minimax/minimax-m2.1": {
    model: "minimax/minimax-m2.1",
    provider: "minimax",
    inputUsdMicrosPerMillion: 300_000,
    cachedInputUsdMicrosPerMillion: 30_000,
    cacheWriteUsdMicrosPerMillion: 380_000,
    outputUsdMicrosPerMillion: 1_200_000,
  },
  "minimax/minimax-m2.1-lightning": {
    model: "minimax/minimax-m2.1-lightning",
    provider: "minimax",
    inputUsdMicrosPerMillion: 300_000,
    cachedInputUsdMicrosPerMillion: 30_000,
    cacheWriteUsdMicrosPerMillion: 380_000,
    outputUsdMicrosPerMillion: 1_200_000,
  },
  "minimax/minimax-m2": {
    model: "minimax/minimax-m2",
    provider: "minimax",
    inputUsdMicrosPerMillion: 300_000,
    cachedInputUsdMicrosPerMillion: 30_000,
    cacheWriteUsdMicrosPerMillion: 380_000,
    outputUsdMicrosPerMillion: 1_200_000,
  },
  "moonshotai/kimi-k2.6": {
    model: "moonshotai/kimi-k2.6",
    provider: "moonshotai",
    inputUsdMicrosPerMillion: 950_000,
    cachedInputUsdMicrosPerMillion: 160_000,
    cacheWriteUsdMicrosPerMillion: 950_000,
    outputUsdMicrosPerMillion: 4_000_000,
  },
  "moonshotai/kimi-k2.5": {
    model: "moonshotai/kimi-k2.5",
    provider: "moonshotai",
    inputUsdMicrosPerMillion: 500_000,
    cachedInputUsdMicrosPerMillion: 100_000,
    cacheWriteUsdMicrosPerMillion: 500_000,
    outputUsdMicrosPerMillion: 2_800_000,
  },
  "moonshotai/kimi-k2-thinking": {
    model: "moonshotai/kimi-k2-thinking",
    provider: "moonshotai",
    inputUsdMicrosPerMillion: 600_000,
    cachedInputUsdMicrosPerMillion: 150_000,
    cacheWriteUsdMicrosPerMillion: 600_000,
    outputUsdMicrosPerMillion: 2_500_000,
  },
  "moonshotai/kimi-k2-thinking-turbo": {
    model: "moonshotai/kimi-k2-thinking-turbo",
    provider: "moonshotai",
    inputUsdMicrosPerMillion: 1_150_000,
    cachedInputUsdMicrosPerMillion: 150_000,
    cacheWriteUsdMicrosPerMillion: 1_150_000,
    outputUsdMicrosPerMillion: 8_000_000,
  },
  "moonshotai/kimi-k2-turbo": {
    model: "moonshotai/kimi-k2-turbo",
    provider: "moonshotai",
    inputUsdMicrosPerMillion: 1_150_000,
    cachedInputUsdMicrosPerMillion: 150_000,
    cacheWriteUsdMicrosPerMillion: 1_150_000,
    outputUsdMicrosPerMillion: 8_000_000,
  },
  "moonshotai/kimi-k2": {
    model: "moonshotai/kimi-k2",
    provider: "moonshotai",
    inputUsdMicrosPerMillion: 570_000,
    cachedInputUsdMicrosPerMillion: 0,
    cacheWriteUsdMicrosPerMillion: 570_000,
    outputUsdMicrosPerMillion: 2_300_000,
  },
  "zai/glm-5.1": {
    model: "zai/glm-5.1",
    provider: "zai",
    inputUsdMicrosPerMillion: 1_400_000,
    cachedInputUsdMicrosPerMillion: 260_000,
    cacheWriteUsdMicrosPerMillion: 1_400_000,
    outputUsdMicrosPerMillion: 4_400_000,
  },
  "zai/glm-5-turbo": {
    model: "zai/glm-5-turbo",
    provider: "zai",
    inputUsdMicrosPerMillion: 1_200_000,
    cachedInputUsdMicrosPerMillion: 240_000,
    cacheWriteUsdMicrosPerMillion: 1_200_000,
    outputUsdMicrosPerMillion: 4_000_000,
  },
  "zai/glm-5v-turbo": {
    model: "zai/glm-5v-turbo",
    provider: "zai",
    inputUsdMicrosPerMillion: 1_200_000,
    cachedInputUsdMicrosPerMillion: 240_000,
    cacheWriteUsdMicrosPerMillion: 1_200_000,
    outputUsdMicrosPerMillion: 4_000_000,
  },
};

export function centsToUsdMicros(cents: number) {
  return Math.round(cents * USD_MICROS_PER_CENT);
}

export function usdMicrosToCents(micros: number) {
  return Math.round(micros / USD_MICROS_PER_CENT);
}

export function calculatePlatformFeeUsdMicros(providerCostUsdMicros: number) {
  if (!Number.isFinite(providerCostUsdMicros) || providerCostUsdMicros <= 0) return 0;
  return Math.round((providerCostUsdMicros * PLATFORM_FEE_BPS) / 10_000);
}

export function calculateModelUsageCost(input: UsageCostInput): UsageCostResult {
  const pricing = MODEL_PRICING[input.modelName as AgentModelId];
  if (!pricing) {
    return {
      billable: false,
      providerCostUsdMicros: 0,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 0,
      costBasis: {
        kind: "model_usage",
        modelName: input.modelName,
        billable: false,
        reason: "unknown_model",
      },
    };
  }

  const longContextMultiplier =
    pricing.model === "openai/gpt-5.4" &&
    safeTokenCount(input.inputTokens) > GPT_5_4_LONG_CONTEXT_INPUT_TOKEN_THRESHOLD
      ? { input: 2, output: 1.5 }
      : { input: 1, output: 1 };
  const uncachedInputRate = pricing.inputUsdMicrosPerMillion * longContextMultiplier.input;
  const cacheReadRate = pricing.cachedInputUsdMicrosPerMillion * longContextMultiplier.input;
  const cacheWriteRate = pricing.cacheWriteUsdMicrosPerMillion * longContextMultiplier.input;
  const outputRate = pricing.outputUsdMicrosPerMillion * longContextMultiplier.output;

  const inputNoCacheCost = tokenCost(input.inputNoCacheTokens, uncachedInputRate);
  const inputCacheReadCost = tokenCost(input.inputCacheReadTokens, cacheReadRate);
  const inputCacheWriteCost = tokenCost(input.inputCacheWriteTokens, cacheWriteRate);
  const outputCost = tokenCost(input.outputTokens, outputRate);
  const providerCostUsdMicros =
    inputNoCacheCost + inputCacheReadCost + inputCacheWriteCost + outputCost;
  const platformFeeUsdMicros = calculatePlatformFeeUsdMicros(providerCostUsdMicros);
  const totalCostUsdMicros = providerCostUsdMicros + platformFeeUsdMicros;

  return {
    billable: totalCostUsdMicros > 0,
    providerCostUsdMicros,
    platformFeeUsdMicros,
    totalCostUsdMicros,
    costBasis: {
      kind: "model_usage",
      modelName: input.modelName,
      provider: pricing.provider,
      pricingVersion: "2026-05-22.standard",
      platformFeeBps: PLATFORM_FEE_BPS,
      longContextApplied: longContextMultiplier.input !== 1 || longContextMultiplier.output !== 1,
      tokenCounts: {
        inputTokens: safeTokenCount(input.inputTokens),
        inputNoCacheTokens: safeTokenCount(input.inputNoCacheTokens),
        inputCacheReadTokens: safeTokenCount(input.inputCacheReadTokens),
        inputCacheWriteTokens: safeTokenCount(input.inputCacheWriteTokens),
        outputTokens: safeTokenCount(input.outputTokens),
      },
      ratesUsdMicrosPerMillion: {
        inputNoCache: uncachedInputRate,
        inputCacheRead: cacheReadRate,
        inputCacheWrite: cacheWriteRate,
        output: outputRate,
      },
      costsUsdMicros: {
        inputNoCache: inputNoCacheCost,
        inputCacheRead: inputCacheReadCost,
        inputCacheWrite: inputCacheWriteCost,
        output: outputCost,
      },
    },
  };
}

export function calculateHostedToolUsageCost(input: {
  provider: string;
  operation: string;
  providerCostUsdMicros: number;
}): UsageCostResult {
  const providerCostUsdMicros = Math.max(Math.round(input.providerCostUsdMicros), 0);
  const platformFeeUsdMicros = calculatePlatformFeeUsdMicros(providerCostUsdMicros);
  const totalCostUsdMicros = providerCostUsdMicros + platformFeeUsdMicros;

  return {
    billable: totalCostUsdMicros > 0,
    providerCostUsdMicros,
    platformFeeUsdMicros,
    totalCostUsdMicros,
    costBasis: {
      kind: "tool_usage",
      provider: input.provider,
      operation: input.operation,
      pricingVersion: "provider-reported.2026-05-22",
      platformFeeBps: PLATFORM_FEE_BPS,
    },
  };
}

export async function recordWorkspaceUsageDebit(input: WorkspaceUsageDebitInput) {
  if (input.totalCostUsdMicros <= 0) {
    return { ok: false as const, reason: "zero_cost" as const };
  }

  const metadata = {
    ...(input.metadata ?? {}),
    platformFeeBps: PLATFORM_FEE_BPS,
  };

  const result = await input.db.execute(sql`
    WITH session_row AS (
      SELECT workspace_id, user_id
      FROM agent_sessions
      WHERE id = ${input.sessionId}
      LIMIT 1
    ),
    inserted_ledger AS (
      INSERT INTO workspace_credit_ledger (
        workspace_id,
        user_id,
        amount_cents,
        amount_usd_micros,
        source,
        session_id,
        message_id,
        model_usage_id,
        tool_usage_id,
        provider_cost_usd_micros,
        platform_fee_usd_micros,
        cost_basis,
        metadata
      )
      SELECT
        workspace_id,
        user_id,
        ${-usdMicrosToCents(input.totalCostUsdMicros)},
        ${-input.totalCostUsdMicros},
        ${input.source},
        ${input.sessionId},
        ${input.messageId ?? null},
        ${input.modelUsageId ?? null},
        ${input.toolUsageId ?? null},
        ${input.providerCostUsdMicros},
        ${input.platformFeeUsdMicros},
        ${JSON.stringify(input.costBasis)}::jsonb,
        ${JSON.stringify(metadata)}::jsonb
      FROM session_row
      ON CONFLICT DO NOTHING
      RETURNING workspace_id, id, amount_usd_micros
    ),
    balance AS (
      INSERT INTO workspace_credit_balances (workspace_id, balance_cents, balance_usd_micros, updated_at)
      SELECT
        workspace_id,
        ${-usdMicrosToCents(input.totalCostUsdMicros)},
        amount_usd_micros,
        now()
      FROM inserted_ledger
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_usd_micros = workspace_credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          balance_cents = ROUND((workspace_credit_balances.balance_usd_micros + excluded.balance_usd_micros)::numeric / ${USD_MICROS_PER_CENT})::integer,
          updated_at = now()
      RETURNING workspace_id, balance_usd_micros
    )
    SELECT inserted_ledger.id AS "ledgerId", balance.balance_usd_micros AS "balanceUsdMicros"
    FROM inserted_ledger
    JOIN balance ON balance.workspace_id = inserted_ledger.workspace_id
  `);

  const rows = rowsFromExecute<{ ledgerId: number; balanceUsdMicros: number }>(result);
  if (!rows[0]) return { ok: false as const, reason: "duplicate_or_missing_session" as const };
  return { ok: true as const, ...rows[0] };
}

export async function hasPositiveWorkspaceBalance(input: {
  db: {
    execute: (query: string | SQLWrapper) => Promise<unknown>;
  };
  workspaceId: string;
}) {
  const result = await input.db.execute(sql`
    SELECT COALESCE(balance_usd_micros, balance_cents::bigint * ${USD_MICROS_PER_CENT}) AS "balanceUsdMicros"
    FROM workspace_credit_balances
    WHERE workspace_id = ${input.workspaceId}
    LIMIT 1
  `);
  const rows = rowsFromExecute<{ balanceUsdMicros: number | string }>(result);
  const rawBalance = rows[0]?.balanceUsdMicros ?? 0;
  const balanceUsdMicros =
    typeof rawBalance === "string" ? Number.parseInt(rawBalance, 10) : rawBalance;
  return Number.isFinite(balanceUsdMicros) && balanceUsdMicros > 0;
}

function tokenCost(tokens: number, usdMicrosPerMillionTokens: number) {
  return Math.round((safeTokenCount(tokens) * usdMicrosPerMillionTokens) / TOKENS_PER_MILLION);
}

function safeTokenCount(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function rowsFromExecute<T extends Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
