import { createHash } from "node:crypto";

/**
 * Stable hash of a metric's config so identical definitions dedupe onto one
 * kpi_metrics row (the unique index covers workspace + provider + key + hash).
 * Key order must not matter, so objects are serialized with sorted keys.
 */
export function kpiConfigHash(config: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex").slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(",")}}`;
}
