// The side channel for reporting model-backed retrieval usage out of the `memory` CLI without the
// model ever seeing it. When the runner invokes the CLI with `--report-usage`, the CLI prints a
// single sentinel line on stdout (`__MEMORY_USAGE__ {json}`); the runner parses that line for
// billing and strips it from the output it returns to the model. Both sides share this module so
// the marker string and JSON shape can never drift.

import type { GatewayUsageEntry } from "./retrieval/gateway";

export type { GatewayUsageEntry } from "./retrieval/gateway";

export const MEMORY_USAGE_MARKER = "__MEMORY_USAGE__";

export type MemoryUsageReport = {
  entries: GatewayUsageEntry[];
};

// Render the sentinel line the CLI appends to stdout under --report-usage.
export function formatMemoryUsageReport(entries: GatewayUsageEntry[]): string {
  const report: MemoryUsageReport = { entries };
  return `${MEMORY_USAGE_MARKER} ${JSON.stringify(report)}`;
}

// Extract the usage report (if any) from raw CLI stdout and return the stdout with every marker
// line removed. Robust to the marker appearing anywhere and to a malformed/absent payload — a
// missing or unparseable report yields an empty entry list and leaves stdout otherwise intact.
export function parseMemoryUsageReport(stdout: string): {
  entries: GatewayUsageEntry[];
  cleanedStdout: string;
} {
  const entries: GatewayUsageEntry[] = [];
  const kept: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith(MEMORY_USAGE_MARKER)) {
      const payload = line.slice(MEMORY_USAGE_MARKER.length).trim();
      entries.push(...parseEntries(payload));
      continue;
    }
    kept.push(line);
  }
  return { entries, cleanedStdout: kept.join("\n") };
}

function parseEntries(payload: string): GatewayUsageEntry[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as MemoryUsageReport;
    return Array.isArray(parsed.entries)
      ? parsed.entries.filter((entry): entry is GatewayUsageEntry => isUsageEntry(entry))
      : [];
  } catch {
    return [];
  }
}

function isUsageEntry(value: unknown): value is GatewayUsageEntry {
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
