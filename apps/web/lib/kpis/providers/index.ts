import { githubKpiProvider } from "@/lib/kpis/providers/github";
import { linearKpiProvider } from "@/lib/kpis/providers/linear";
import { posthogKpiProvider } from "@/lib/kpis/providers/posthog";
import type { KpiCatalogEntry, KpiProvider } from "@/lib/kpis/types";

/** Type-erased provider: connections flow getConnection → fetchMetric opaquely. */
export type AnyKpiProvider = KpiProvider<unknown>;

/**
 * Provider registry. Adding an integration to the KPI board = implementing
 * KpiProvider and listing it here; the picker, refresh sweep, and cards all
 * derive from this list. The cast erases each provider's connection type —
 * sound because a connection only ever round-trips through the same provider.
 */
const KPI_PROVIDERS = [
  githubKpiProvider,
  linearKpiProvider,
  posthogKpiProvider,
] as unknown as AnyKpiProvider[];

export function listKpiProviders(): AnyKpiProvider[] {
  return KPI_PROVIDERS;
}

export function getKpiProvider(providerId: string): AnyKpiProvider | null {
  return KPI_PROVIDERS.find((provider) => provider.id === providerId) ?? null;
}

export function getKpiCatalogEntry(
  providerId: string,
  metricKey: string,
): { provider: AnyKpiProvider; entry: KpiCatalogEntry } | null {
  const provider = getKpiProvider(providerId);
  if (!provider) return null;
  const entry = provider.catalog.find((candidate) => candidate.key === metricKey);
  return entry ? { provider, entry } : null;
}
