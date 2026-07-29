import { drizzle } from "drizzle-orm/neon-http";
import { describe, expect, it, vi } from "vitest";
import { getGoatBrainOverviewStats } from "./brain-overview";

describe("getGoatBrainOverviewStats", () => {
  it("does not count Slack bot destinations as active ingestion sources", async () => {
    const query = vi.fn(async (statement: string, params: unknown[]) => {
      void params;
      return {
        rows: statement.includes('from "goat"."brain_documents"')
          ? [[11]]
          : statement.includes('from "goat"."brain_tool_runs"')
            ? [[7]]
            : [[3]],
      };
    });
    const db = drizzle(query as never);

    await expect(
      getGoatBrainOverviewStats(
        "brain_123",
        new Date("2026-07-16T10:00:00.000Z"),
        db as unknown as ReturnType<typeof import("@opencompany/db/client").getDb>,
      ),
    ).resolves.toMatchObject({
      itemsAddedLast7Days: 11,
      retrievalsLast7Days: 7,
      activeSources: 3,
    });

    const sourceQuery = query.mock.calls.find(([statement]) =>
      statement.includes('from "goat"."brain_sources"'),
    );
    expect(sourceQuery).toBeDefined();
    expect(sourceQuery?.[0].replace(/\s+/g, " ")).toContain('"provider" <>');
    expect(sourceQuery?.[1]).toContain("slack_bot");
  });
});
