import { AUX_GATEWAY_MODEL_PRICING, calculateModelUsageCost } from "@opencompany/billing";
import type { BrokerProvider } from "./llm-broker-tokens";

// Pure usage extraction + pricing for the LLM broker (llm-broker.ts). Everything here is
// side-effect free so the response-shape handling is unit-testable without a proxy.
//
// Field tolerance mirrors packages/memory/src/retrieval/gateway.ts: the broker fronts
// both the Vercel AI Gateway's OpenAI-compatible endpoints (chat/embeddings, any routed
// provider) and OpenAI's Responses API (codex), so token fields may arrive in either
// naming convention; the Gateway may additionally report a dollar cost.

export type BrokerEndpoint = "chat.completions" | "embeddings" | "responses" | "models";

export type ParsedBrokerUsage = {
  parsed: boolean;
  inputTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
  // Gateway-reported dollar cost, when present — preferred over catalog pricing.
  providerCostUsd: number | null;
  raw: Record<string, unknown>;
};

const EMPTY_USAGE: ParsedBrokerUsage = {
  parsed: false,
  inputTokens: 0,
  inputCacheReadTokens: 0,
  inputCacheWriteTokens: 0,
  outputTokens: 0,
  providerCostUsd: null,
  raw: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

// Extract usage out of a `usage` record in either OpenAI naming convention:
// chat completions (`prompt_tokens`/`completion_tokens`, cached reads under
// `prompt_tokens_details.cached_tokens`) or the Responses API (`input_tokens`/
// `output_tokens`, cached reads under `input_tokens_details.cached_tokens`).
// Anthropic-style cache-write counts surface via the Gateway as
// `cache_creation_input_tokens` when present.
function usageFromRecord(
  usage: Record<string, unknown>,
  container: Record<string, unknown>,
): ParsedBrokerUsage {
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const inputTokens = numberOr(usage.prompt_tokens ?? usage.input_tokens, 0);
  const outputTokens = numberOr(usage.completion_tokens ?? usage.output_tokens, 0);
  const inputCacheReadTokens = numberOr(
    promptDetails.cached_tokens ?? inputDetails.cached_tokens ?? usage.cached_input_tokens,
    0,
  );
  const inputCacheWriteTokens = numberOr(usage.cache_creation_input_tokens, 0);
  const providerCostUsd = firstNumber(usage.cost, usage.cost_usd, container.cost);
  const parsed = inputTokens > 0 || outputTokens > 0 || providerCostUsd != null;
  return {
    parsed,
    inputTokens,
    inputCacheReadTokens,
    inputCacheWriteTokens,
    outputTokens,
    providerCostUsd,
    raw: usage,
  };
}

// Usage from a non-streaming JSON response body (chat completion, embeddings, or a
// complete Responses API object). Returns EMPTY_USAGE (parsed: false) when absent.
export function parseJsonUsage(body: unknown): ParsedBrokerUsage {
  const record = isRecord(body) ? body : {};
  // A Responses API body nests the response under `response` for some event shapes;
  // accept both the flat object and the nested one.
  const container =
    isRecord(record.response) && isRecord(record.response.usage)
      ? (record.response as Record<string, unknown>)
      : record;
  const usage = isRecord(container.usage) ? container.usage : null;
  if (!usage) return EMPTY_USAGE;
  return usageFromRecord(usage, container);
}

// Incremental SSE scanner for streamed responses. Feed raw text chunks; it splits on
// event boundaries, parses `data:` JSON payloads, and keeps the LAST usage seen:
// - chat completions: the final chunk carries `usage` (the broker injects
//   `stream_options.include_usage` to guarantee it);
// - Responses API: the `response.completed` event carries `response.usage`.
export function createSseUsageScanner() {
  let buffer = "";
  let latest: ParsedBrokerUsage = EMPTY_USAGE;

  function scanEvent(eventText: string) {
    for (const line of eventText.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let data: unknown;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      const candidate = parseJsonUsage(data);
      if (candidate.parsed) latest = candidate;
    }
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        scanEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    },
    finish(): ParsedBrokerUsage {
      if (buffer) {
        scanEvent(buffer);
        buffer = "";
      }
      return latest;
    },
  };
}

// Normalize the model id a CLI sent into a platform catalog key. Gateway requests
// already use catalog ids (`anthropic/claude-sonnet-4.6`); codex sends bare OpenAI
// model names (`gpt-5.2-codex`).
export function normalizeBrokerModelId(provider: BrokerProvider, model: string): string {
  if (provider === "openai" && !model.includes("/")) return `openai/${model}`;
  return model;
}

// Price one upstream request in USD micros. Preference order:
// 1. Gateway-reported dollar cost on the response.
// 2. Platform model catalog (MODEL_PRICING via calculateModelUsageCost) — provider cost
//    only; the platform fee is applied once at settlement.
// 3. AUX_GATEWAY_MODEL_PRICING for off-catalog gateway models (embeddings, nano).
// 4. Zero — billing must never guess. The caller records usageParsed so unpriceable
//    requests stay visible for reconciliation.
export function priceBrokerRequest(input: {
  provider: BrokerProvider;
  model: string | null;
  usage: ParsedBrokerUsage;
}): number {
  const { usage } = input;
  if (usage.providerCostUsd != null && usage.providerCostUsd > 0) {
    return Math.round(usage.providerCostUsd * 1_000_000);
  }
  if (!input.model) return 0;

  const modelName = normalizeBrokerModelId(input.provider, input.model);
  const inputNoCacheTokens = Math.max(
    0,
    usage.inputTokens - usage.inputCacheReadTokens - usage.inputCacheWriteTokens,
  );
  const catalog = calculateModelUsageCost({
    modelName,
    inputTokens: usage.inputTokens,
    inputNoCacheTokens,
    inputCacheReadTokens: usage.inputCacheReadTokens,
    inputCacheWriteTokens: usage.inputCacheWriteTokens,
    outputTokens: usage.outputTokens,
  });
  if (catalog.costBasis.reason !== "unknown_model") {
    return catalog.providerCostUsdMicros;
  }

  const aux = AUX_GATEWAY_MODEL_PRICING[modelName];
  if (!aux) return 0;
  const inputCost = (usage.inputTokens / 1_000_000) * aux.inputUsdMicrosPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * aux.outputUsdMicrosPerMillion;
  return Math.round(inputCost + outputCost);
}
