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
  | "xai"
  | "zai";

type ModelPricing = {
  model: AgentModelId;
  provider: PricingProvider;
  inputUsdMicrosPerMillion: number;
  cachedInputUsdMicrosPerMillion: number;
  cacheWriteUsdMicrosPerMillion: number;
  outputUsdMicrosPerMillion: number;
  longContext?: {
    inputTokenThreshold: number;
    inputMultiplier: number;
    outputMultiplier: number;
  };
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
  sandboxUsageId?: number | null;
  source: "model_usage" | "tool_usage" | "sandbox_usage";
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  totalCostUsdMicros: number;
  costBasis: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

const MODEL_PRICING: Partial<Record<AgentModelId, ModelPricing>> = {
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
  "anthropic/claude-fable-5": {
    model: "anthropic/claude-fable-5",
    provider: "anthropic",
    inputUsdMicrosPerMillion: 10_000_000,
    cachedInputUsdMicrosPerMillion: 1_000_000,
    cacheWriteUsdMicrosPerMillion: 12_500_000,
    outputUsdMicrosPerMillion: 50_000_000,
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
  "xai/grok-4.3": {
    model: "xai/grok-4.3",
    provider: "xai",
    inputUsdMicrosPerMillion: 1_250_000,
    cachedInputUsdMicrosPerMillion: 200_000,
    cacheWriteUsdMicrosPerMillion: 1_250_000,
    outputUsdMicrosPerMillion: 2_500_000,
    longContext: {
      inputTokenThreshold: 200_001,
      inputMultiplier: 2,
      outputMultiplier: 2,
    },
  },
  "xai/grok-4.20-reasoning": {
    model: "xai/grok-4.20-reasoning",
    provider: "xai",
    inputUsdMicrosPerMillion: 1_250_000,
    cachedInputUsdMicrosPerMillion: 200_000,
    cacheWriteUsdMicrosPerMillion: 1_250_000,
    outputUsdMicrosPerMillion: 2_500_000,
    longContext: {
      inputTokenThreshold: 200_001,
      inputMultiplier: 2,
      outputMultiplier: 2,
    },
  },
  "xai/grok-4.20-non-reasoning": {
    model: "xai/grok-4.20-non-reasoning",
    provider: "xai",
    inputUsdMicrosPerMillion: 1_250_000,
    cachedInputUsdMicrosPerMillion: 200_000,
    cacheWriteUsdMicrosPerMillion: 1_250_000,
    outputUsdMicrosPerMillion: 2_500_000,
    longContext: {
      inputTokenThreshold: 200_001,
      inputMultiplier: 2,
      outputMultiplier: 2,
    },
  },
  "xai/grok-4.1-fast-reasoning": {
    model: "xai/grok-4.1-fast-reasoning",
    provider: "xai",
    inputUsdMicrosPerMillion: 200_000,
    cachedInputUsdMicrosPerMillion: 50_000,
    cacheWriteUsdMicrosPerMillion: 200_000,
    outputUsdMicrosPerMillion: 500_000,
  },
  "xai/grok-4.1-fast-non-reasoning": {
    model: "xai/grok-4.1-fast-non-reasoning",
    provider: "xai",
    inputUsdMicrosPerMillion: 200_000,
    cachedInputUsdMicrosPerMillion: 50_000,
    cacheWriteUsdMicrosPerMillion: 200_000,
    outputUsdMicrosPerMillion: 500_000,
  },
  "xai/grok-build-0.1": {
    model: "xai/grok-build-0.1",
    provider: "xai",
    inputUsdMicrosPerMillion: 1_000_000,
    cachedInputUsdMicrosPerMillion: 200_000,
    cacheWriteUsdMicrosPerMillion: 1_000_000,
    outputUsdMicrosPerMillion: 2_000_000,
    longContext: {
      inputTokenThreshold: 200_001,
      inputMultiplier: 2,
      outputMultiplier: 2,
    },
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
const VARIABLE_PRICED_MODELS = new Set<AgentModelId>(["openrouter/fusion"]);

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
    const reason = VARIABLE_PRICED_MODELS.has(input.modelName as AgentModelId)
      ? "variable_pricing"
      : "unknown_model";
    return {
      billable: false,
      providerCostUsdMicros: 0,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 0,
      costBasis: {
        kind: "model_usage",
        modelName: input.modelName,
        billable: false,
        reason,
      },
    };
  }

  const configuredLongContext =
    pricing.longContext &&
    safeTokenCount(input.inputTokens) > pricing.longContext.inputTokenThreshold
      ? {
          input: pricing.longContext.inputMultiplier,
          output: pricing.longContext.outputMultiplier,
        }
      : null;
  const legacyOpenAiLongContext =
    pricing.model === "openai/gpt-5.4" &&
    safeTokenCount(input.inputTokens) > GPT_5_4_LONG_CONTEXT_INPUT_TOKEN_THRESHOLD
      ? { input: 2, output: 1.5 }
      : null;
  const longContextMultiplier = configuredLongContext ??
    legacyOpenAiLongContext ?? { input: 1, output: 1 };
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

// How a hosted tool's providerCostUsdMicros was determined. Most tools pass through a
// figure the provider itself reported; tools whose provider cannot price the platform's
// gateway models (e.g. opencode, OC-328) compute it from token counts with MODEL_PRICING.
// "broker_metered" rows were measured server-side by the runner's LLM broker from upstream
// responses — the tamper-proof billable record for brokered delegations; the CLI's own
// self-reported usage rows then carry cost 0 (display-only).
export type HostedToolCostSource =
  | "provider_reported"
  | "platform_model_pricing"
  | "broker_metered";

// Pricing fallback for gateway models that are not part of the agent model catalog
// (MODEL_PRICING), e.g. the memory CLI's embedding/nano retrieval models. Values are
// USD-micros per million tokens. Consumers (memory tool, LLM broker) use this only when
// the model is absent from MODEL_PRICING and no provider-reported cost exists; an unknown
// model prices to 0 rather than guessing.
export const AUX_GATEWAY_MODEL_PRICING: Record<
  string,
  { inputUsdMicrosPerMillion: number; outputUsdMicrosPerMillion: number }
> = {
  "openai/text-embedding-3-small": {
    inputUsdMicrosPerMillion: 20_000,
    outputUsdMicrosPerMillion: 0,
  },
  "openai/gpt-5.4-nano": {
    inputUsdMicrosPerMillion: 200_000,
    outputUsdMicrosPerMillion: 1_250_000,
  },
};

export function calculateHostedToolUsageCost(input: {
  provider: string;
  operation: string;
  providerCostUsdMicros: number;
  costSource?: HostedToolCostSource;
}): UsageCostResult {
  const providerCostUsdMicros = Math.max(Math.round(input.providerCostUsdMicros), 0);
  const platformFeeUsdMicros = calculatePlatformFeeUsdMicros(providerCostUsdMicros);
  const totalCostUsdMicros = providerCostUsdMicros + platformFeeUsdMicros;
  const costSource = input.costSource ?? "provider_reported";

  return {
    billable: totalCostUsdMicros > 0,
    providerCostUsdMicros,
    platformFeeUsdMicros,
    totalCostUsdMicros,
    costBasis: {
      kind: "tool_usage",
      provider: input.provider,
      operation: input.operation,
      costSource,
      // Platform-priced tool usage is billed from the same model catalog as model_usage
      // rows, so it carries that catalog's version string. Broker-metered usage is also
      // priced from that catalog (per upstream request, at metering time).
      pricingVersion:
        costSource === "platform_model_pricing" || costSource === "broker_metered"
          ? "2026-05-22.standard"
          : "provider-reported.2026-05-22",
      platformFeeBps: PLATFORM_FEE_BPS,
    },
  };
}

// --- E2B sandbox compute pricing ---------------------------------------------
// E2B bills sandbox compute per second of *running* (non-paused) time, scaled by the
// sandbox's allocated vCPU and RAM. Rates are expressed in USD micros per second.
// ⚠️ Confirm these against E2B's current published compute pricing before relying on
// the billed amounts — bump SANDBOX_PRICING_VERSION when they change.
export const SANDBOX_VCPU_USD_MICROS_PER_SECOND = 14; // $0.000014 per vCPU-second
export const SANDBOX_RAM_GIB_USD_MICROS_PER_SECOND = 4.5; // $0.0000045 per GiB-second
const SANDBOX_PRICING_VERSION = "e2b.2026-06.standard";
const MIB_PER_GIB = 1024;

export type SandboxResourceConfig = {
  vcpu: number;
  ramMiB: number;
};

// E2B base sandbox allocation. Templates that change CPU/RAM should resolve their own
// resources before pricing (see the runner's resolveSandboxResources).
export const DEFAULT_SANDBOX_RESOURCES: SandboxResourceConfig = { vcpu: 2, ramMiB: 512 };

export type SandboxUsageCostInput = {
  template?: string | null;
  vcpu: number;
  ramMiB: number;
  activeMs: number;
};

export function calculateSandboxUsageCost(input: SandboxUsageCostInput): UsageCostResult {
  const activeMs =
    Number.isFinite(input.activeMs) && input.activeMs > 0 ? Math.floor(input.activeMs) : 0;
  const activeSeconds = activeMs / 1000;
  const vcpu = Number.isFinite(input.vcpu) && input.vcpu > 0 ? input.vcpu : 0;
  const ramGiB = Number.isFinite(input.ramMiB) && input.ramMiB > 0 ? input.ramMiB / MIB_PER_GIB : 0;

  const vcpuCostUsdMicros = Math.round(activeSeconds * vcpu * SANDBOX_VCPU_USD_MICROS_PER_SECOND);
  const ramCostUsdMicros = Math.round(
    activeSeconds * ramGiB * SANDBOX_RAM_GIB_USD_MICROS_PER_SECOND,
  );
  const providerCostUsdMicros = vcpuCostUsdMicros + ramCostUsdMicros;
  const platformFeeUsdMicros = calculatePlatformFeeUsdMicros(providerCostUsdMicros);
  const totalCostUsdMicros = providerCostUsdMicros + platformFeeUsdMicros;

  return {
    billable: totalCostUsdMicros > 0,
    providerCostUsdMicros,
    platformFeeUsdMicros,
    totalCostUsdMicros,
    costBasis: {
      kind: "sandbox_usage",
      template: input.template ?? null,
      pricingVersion: SANDBOX_PRICING_VERSION,
      platformFeeBps: PLATFORM_FEE_BPS,
      vcpu,
      ramMiB: Number.isFinite(input.ramMiB) && input.ramMiB > 0 ? Math.floor(input.ramMiB) : 0,
      activeMs,
      ratesUsdMicrosPerSecond: {
        vcpu: SANDBOX_VCPU_USD_MICROS_PER_SECOND,
        ramGiB: SANDBOX_RAM_GIB_USD_MICROS_PER_SECOND,
      },
      costsUsdMicros: {
        vcpu: vcpuCostUsdMicros,
        ram: ramCostUsdMicros,
      },
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
        sandbox_usage_id,
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
        ${input.sandboxUsageId ?? null},
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

type ExecutableDb = {
  execute: (query: string | SQLWrapper) => Promise<unknown>;
};

// Sources that represent money spent running agents (as opposed to top-ups,
// signup bonuses, or promo credits). These count toward the weekly spend limit.
const USAGE_LEDGER_SOURCES = ["model_usage", "tool_usage", "sandbox_usage"] as const;

// Monday 00:00:00.000 UTC of the week containing `now`. The weekly spend limit
// resets on this boundary; we use a fixed weekly cadence (not a rolling window)
// so the UI can show a concrete "resets on <date>".
export function getWeekStartUtc(now: Date): Date {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7; // getUTCDay: 0=Sun..6=Sat
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return start;
}

// Start of the next week — the moment the current week's spend resets to zero.
export function getWeekResetAtUtc(now: Date): Date {
  const next = getWeekStartUtc(now);
  next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

function toFiniteNumber(value: number | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Total usage spend (positive micros) recorded since `since`. Reads the ledger,
// summing the magnitude of usage debits. Relies on the existing
// (workspace_id, created_at) ledger index.
export async function getUsageSpendSinceUsdMicros(input: {
  db: ExecutableDb;
  workspaceId: string;
  since: Date;
}): Promise<number> {
  const result = await input.db.execute(sql`
    SELECT COALESCE(SUM(-amount_usd_micros), 0) AS "spendUsdMicros"
    FROM workspace_credit_ledger
    WHERE workspace_id = ${input.workspaceId}
      AND amount_usd_micros < 0
      AND source IN (${sql.join(
        USAGE_LEDGER_SOURCES.map((source) => sql`${source}`),
        sql`, `,
      )})
      AND created_at >= ${input.since.toISOString()}
  `);
  const rows = rowsFromExecute<{ spendUsdMicros: number | string }>(result);
  return toFiniteNumber(rows[0]?.spendUsdMicros);
}

export type RunAllowanceReason = "no_balance" | "weekly_limit_reached";

export type WorkspaceRunAllowance = {
  allowed: boolean;
  reason: RunAllowanceReason | null;
  balanceUsdMicros: number;
  weeklySpendUsdMicros: number;
  weeklySpendLimitUsdMicros: number | null;
  spendLimitEnabled: boolean;
  weekStartsAt: Date;
};

// Single-round-trip gate combining the positive-balance check with the weekly
// spend limit. Read-only and side-effect free so it can be reused by run gates,
// the auto-refill evaluator, and the billing UI.
//
// Reason priority: weekly_limit_reached takes precedence over no_balance, because
// when the cap is hit adding credits (or auto-refilling) won't unblock the user —
// they must raise the limit or wait for the weekly reset.
export async function checkWorkspaceRunAllowance(input: {
  db: ExecutableDb;
  workspaceId: string;
  now?: Date;
}): Promise<WorkspaceRunAllowance> {
  const now = input.now ?? new Date();
  const weekStartsAt = getWeekStartUtc(now);

  const result = await input.db.execute(sql`
    WITH bal AS (
      SELECT COALESCE(balance_usd_micros, balance_cents::bigint * ${USD_MICROS_PER_CENT}) AS balance
      FROM workspace_credit_balances
      WHERE workspace_id = ${input.workspaceId}
      LIMIT 1
    ),
    settings AS (
      SELECT spend_limit_enabled, weekly_spend_limit_usd_micros
      FROM workspace_billing_settings
      WHERE workspace_id = ${input.workspaceId}
      LIMIT 1
    ),
    spend AS (
      SELECT COALESCE(SUM(-amount_usd_micros), 0) AS weekly_spend
      FROM workspace_credit_ledger
      WHERE workspace_id = ${input.workspaceId}
        AND amount_usd_micros < 0
        AND source IN (${sql.join(
          USAGE_LEDGER_SOURCES.map((source) => sql`${source}`),
          sql`, `,
        )})
        AND created_at >= ${weekStartsAt.toISOString()}
    )
    SELECT
      COALESCE((SELECT balance FROM bal), 0) AS "balanceUsdMicros",
      COALESCE((SELECT spend_limit_enabled FROM settings), false) AS "spendLimitEnabled",
      (SELECT weekly_spend_limit_usd_micros FROM settings) AS "weeklySpendLimitUsdMicros",
      COALESCE((SELECT weekly_spend FROM spend), 0) AS "weeklySpendUsdMicros"
  `);

  const rows = rowsFromExecute<{
    balanceUsdMicros: number | string;
    spendLimitEnabled: boolean;
    weeklySpendLimitUsdMicros: number | string | null;
    weeklySpendUsdMicros: number | string;
  }>(result);
  const row = rows[0];

  const balanceUsdMicros = toFiniteNumber(row?.balanceUsdMicros);
  const spendLimitEnabled = row?.spendLimitEnabled === true;
  const weeklySpendLimitUsdMicros =
    row?.weeklySpendLimitUsdMicros === null || row?.weeklySpendLimitUsdMicros === undefined
      ? null
      : toFiniteNumber(row.weeklySpendLimitUsdMicros);
  const weeklySpendUsdMicros = toFiniteNumber(row?.weeklySpendUsdMicros);

  const base = {
    balanceUsdMicros,
    weeklySpendUsdMicros,
    weeklySpendLimitUsdMicros,
    spendLimitEnabled,
    weekStartsAt,
  };

  if (
    spendLimitEnabled &&
    weeklySpendLimitUsdMicros !== null &&
    weeklySpendUsdMicros >= weeklySpendLimitUsdMicros
  ) {
    return { allowed: false, reason: "weekly_limit_reached", ...base };
  }

  if (balanceUsdMicros <= 0) {
    return { allowed: false, reason: "no_balance", ...base };
  }

  return { allowed: true, reason: null, ...base };
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
