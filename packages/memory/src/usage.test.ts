import { describe, expect, it } from "vitest";
import type { GatewayUsageEntry } from "./retrieval/gateway";
import { formatMemoryUsageReport, MEMORY_USAGE_MARKER, parseMemoryUsageReport } from "./usage";

const entries: GatewayUsageEntry[] = [
  {
    model: "openai/text-embedding-3-small",
    operation: "embeddings",
    inputTokens: 100,
    outputTokens: 0,
    totalTokens: 100,
    costUsd: null,
  },
  {
    model: "openai/gpt-5.4-nano",
    operation: "chat",
    inputTokens: 40,
    outputTokens: 10,
    totalTokens: 50,
    costUsd: 0.0001,
  },
];

describe("memory usage report", () => {
  it("round-trips entries and strips the marker line from surrounding output", () => {
    const output = ["calling gateway...", formatMemoryUsageReport(entries), ""].join("\n");
    const { entries: parsed, cleanedStdout } = parseMemoryUsageReport(output);
    expect(parsed).toEqual(entries);
    expect(cleanedStdout).toBe("calling gateway...\n");
    expect(cleanedStdout).not.toContain(MEMORY_USAGE_MARKER);
  });

  it("returns no entries and leaves output intact when there is no marker", () => {
    const { entries: parsed, cleanedStdout } = parseMemoryUsageReport("just results\n");
    expect(parsed).toEqual([]);
    expect(cleanedStdout).toBe("just results\n");
  });

  it("ignores a malformed marker payload without throwing", () => {
    const { entries: parsed, cleanedStdout } = parseMemoryUsageReport(
      `${MEMORY_USAGE_MARKER} {not json`,
    );
    expect(parsed).toEqual([]);
    expect(cleanedStdout).toBe("");
  });

  it("drops entries that do not match the usage shape", () => {
    const { entries: parsed } = parseMemoryUsageReport(
      `${MEMORY_USAGE_MARKER} ${JSON.stringify({ entries: [{ model: "x" }, entries[0]] })}`,
    );
    expect(parsed).toEqual([entries[0]]);
  });
});
