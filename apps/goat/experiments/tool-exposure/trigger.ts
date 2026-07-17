import type { MockIntegration, TriggerResult } from "./types";

export function matchIntegrations(
  message: string,
  integrations: readonly MockIntegration[],
): TriggerResult {
  const startedAt = performance.now();
  const expandedIntegrationIds: string[] = [];
  const reasons: TriggerResult["reasons"] = [];

  for (const integration of integrations) {
    for (const pattern of integration.triggerPatterns) {
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(message);
      if (!match) continue;
      if (!expandedIntegrationIds.includes(integration.id)) {
        expandedIntegrationIds.push(integration.id);
      }
      reasons.push({
        integrationId: integration.id,
        integrationName: integration.name,
        pattern: pattern.label,
        match: match[0],
      });
    }
  }

  return {
    expandedIntegrationIds,
    reasons,
    latencyMs: performance.now() - startedAt,
  };
}

export function benchmarkTriggerLatency(
  message: string,
  integrations: readonly MockIntegration[],
  iterations = 10_000,
): { iterations: number; totalMs: number; meanMs: number; p95Ms: number } {
  const samples: number[] = [];
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    samples.push(matchIntegrations(message, integrations).latencyMs);
  }
  const totalMs = performance.now() - startedAt;
  samples.sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(samples.length * 0.95) - 1);
  return {
    iterations,
    totalMs,
    meanMs: totalMs / iterations,
    p95Ms: samples[p95Index] ?? 0,
  };
}
