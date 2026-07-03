import type { GoatBrainUsageEntry } from "./retrieval/gateway";

export type { GoatBrainUsageEntry } from "./retrieval/gateway";

export const GOAT_BRAIN_USAGE_MARKER = "__GOAT_BRAIN_USAGE__";

export type GoatBrainUsageReport = {
  entries: GoatBrainUsageEntry[];
};

export function formatGoatBrainUsageReport(entries: GoatBrainUsageEntry[]): string {
  return `${GOAT_BRAIN_USAGE_MARKER} ${JSON.stringify({ entries } satisfies GoatBrainUsageReport)}`;
}

export function parseGoatBrainUsageReport(stdout: string): {
  entries: GoatBrainUsageEntry[];
  cleanedStdout: string;
} {
  const entries: GoatBrainUsageEntry[] = [];
  const kept: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith(GOAT_BRAIN_USAGE_MARKER)) {
      entries.push(...parseEntries(line.slice(GOAT_BRAIN_USAGE_MARKER.length).trim()));
      continue;
    }
    kept.push(line);
  }
  return { entries, cleanedStdout: kept.join("\n") };
}

function parseEntries(payload: string): GoatBrainUsageEntry[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as GoatBrainUsageReport;
    return Array.isArray(parsed.entries)
      ? parsed.entries.filter((entry): entry is GoatBrainUsageEntry => isUsageEntry(entry))
      : [];
  } catch {
    return [];
  }
}

function isUsageEntry(value: unknown): value is GoatBrainUsageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.model === "string" &&
    (entry.operation === "embeddings" || entry.operation === "chat") &&
    typeof entry.inputTokens === "number" &&
    typeof entry.outputTokens === "number" &&
    typeof entry.totalTokens === "number"
  );
}
