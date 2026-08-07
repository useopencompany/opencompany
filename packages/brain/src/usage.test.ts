import { describe, expect, it } from "vitest";
import {
  type BrainUsageEntry,
  formatBrainUsageReport,
  GOAT_BRAIN_USAGE_MARKER,
  isUsageEntry,
  parseBrainUsageReport,
} from "./usage";

const entries: BrainUsageEntry[] = [
  {
    operation: "chat",
    model: "openai/gpt-5.5",
    inputTokens: 120,
    outputTokens: 40,
    totalTokens: 160,
    costUsd: null,
  },
  {
    operation: "embeddings",
    model: "openai/text-embedding-3-large",
    inputTokens: 24,
    outputTokens: 0,
    totalTokens: 24,
    costUsd: null,
  },
];

describe("goat brain usage reports", () => {
  it("round-trips multiple usage entries", () => {
    const parsed = parseBrainUsageReport(formatBrainUsageReport(entries));

    expect(parsed.entries).toEqual(entries);
    expect(parsed.entries.every(isUsageEntry)).toBe(true);
    expect(parsed.cleanedStdout).toBe("");
  });

  it("removes marker lines while preserving ordinary stdout", () => {
    const stdout = [
      "first line",
      `[runner] ${formatBrainUsageReport([entries[0]!])}`,
      "second line",
      `${GOAT_BRAIN_USAGE_MARKER} ${JSON.stringify({ entries: [entries[1]!] })}`,
      "",
    ].join("\n");

    const parsed = parseBrainUsageReport(stdout);

    expect(parsed.entries).toEqual(entries);
    expect(parsed.cleanedStdout).toBe("first line\nsecond line\n");
  });

  it("ignores malformed and invalid marker payloads", () => {
    const stdout = [
      `${GOAT_BRAIN_USAGE_MARKER} not json`,
      `${GOAT_BRAIN_USAGE_MARKER} ${JSON.stringify({
        entries: [
          { model: "missing-fields" },
          {
            operation: "chat",
            model: "openai/gpt-5.5",
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        ],
      })}`,
      "kept",
    ].join("\n");

    expect(parseBrainUsageReport(stdout)).toEqual({
      entries: [],
      cleanedStdout: "kept",
    });
  });
});
