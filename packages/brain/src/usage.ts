import type { BrainUsageEntry } from "./retrieval/gateway";

export type { BrainUsageEntry } from "./retrieval/gateway";

export const BRAIN_USAGE_MARKER = "__OPENCOMPANY_BRAIN_USAGE__";

export type BrainUsageReport = {
  entries: BrainUsageEntry[];
};

export function formatBrainUsageReport(entries: BrainUsageEntry[]): string {
  return `${BRAIN_USAGE_MARKER} ${JSON.stringify({ entries } satisfies BrainUsageReport)}`;
}

export function parseBrainUsageReport(stdout: string): {
  entries: BrainUsageEntry[];
  cleanedStdout: string;
} {
  const entries: BrainUsageEntry[] = [];
  const kept: string[] = [];
  for (const line of stdout.split("\n")) {
    const markerIndex = line.indexOf(BRAIN_USAGE_MARKER);
    if (markerIndex !== -1) {
      entries.push(...parseEntries(line.slice(markerIndex + BRAIN_USAGE_MARKER.length).trim()));
      continue;
    }
    kept.push(line);
  }
  return { entries, cleanedStdout: kept.join("\n") };
}

function parseEntries(payload: string): BrainUsageEntry[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as BrainUsageReport;
    return Array.isArray(parsed.entries)
      ? parsed.entries.filter((entry): entry is BrainUsageEntry => isUsageEntry(entry))
      : [];
  } catch {
    return [];
  }
}

export function isUsageEntry(value: unknown): value is BrainUsageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.model === "string" &&
    (entry.operation === "embeddings" || entry.operation === "chat") &&
    typeof entry.inputTokens === "number" &&
    typeof entry.outputTokens === "number" &&
    typeof entry.totalTokens === "number" &&
    (entry.costUsd === null || typeof entry.costUsd === "number")
  );
}
