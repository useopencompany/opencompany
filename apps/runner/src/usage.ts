import type { LanguageModelUsage } from "ai";

export type NormalizedModelUsage = {
  inputTokens: number;
  inputNoCacheTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
  outputTextTokens: number;
  outputReasoningTokens: number;
  totalTokens: number;
  rawUsage: Record<string, unknown>;
};

export function normalizeModelUsage(usage: LanguageModelUsage): NormalizedModelUsage {
  const inputTokens = tokenCount(usage.inputTokens);
  const inputCacheReadTokens = tokenCount(
    usage.inputTokenDetails.cacheReadTokens ?? usage.cachedInputTokens,
  );
  const inputCacheWriteTokens = tokenCount(usage.inputTokenDetails.cacheWriteTokens);
  const inputNoCacheTokens = tokenCount(
    usage.inputTokenDetails.noCacheTokens ??
      subtractIfKnown(inputTokens, inputCacheReadTokens + inputCacheWriteTokens),
  );

  const outputTokens = tokenCount(usage.outputTokens);
  const outputReasoningTokens = tokenCount(
    usage.outputTokenDetails.reasoningTokens ?? usage.reasoningTokens,
  );
  const outputTextTokens = tokenCount(
    usage.outputTokenDetails.textTokens ?? subtractIfKnown(outputTokens, outputReasoningTokens),
  );

  return {
    inputTokens,
    inputNoCacheTokens,
    inputCacheReadTokens,
    inputCacheWriteTokens,
    outputTokens,
    outputTextTokens,
    outputReasoningTokens,
    totalTokens: tokenCount(usage.totalTokens ?? inputTokens + outputTokens),
    rawUsage: isRecord(usage.raw) ? usage.raw : {},
  };
}

function tokenCount(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function subtractIfKnown(total: number, detail: number) {
  if (total <= 0) return undefined;
  return Math.max(total - detail, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
