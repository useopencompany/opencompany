import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGoatDailyUsage, getGoatUsageDrilldown } from "@/lib/gateway-usage";

const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: dbMock.getDb,
}));

describe("Goat Gateway usage reporting", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("fills empty UTC days from Vercel daily report rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          results: [
            {
              day: "2026-07-09",
              total_cost: 1.25,
              market_cost: 1.25,
              surcharge_cost: 0,
              gateway_cost: 0,
              input_tokens: 100,
              output_tokens: 25,
              cached_input_tokens: 10,
              cache_creation_input_tokens: 5,
              reasoning_tokens: 3,
              request_count: 2,
            },
          ],
        }),
      ),
    );

    await expect(
      getGoatDailyUsage({
        apiKey: "gateway-key",
        userWorkosId: "user_123",
        start: "2026-07-08",
        end: "2026-07-09",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        day: "2026-07-08",
        totalCostUsdMicros: 0,
        requestCount: 0,
      }),
      expect.objectContaining({
        day: "2026-07-09",
        totalCostUsdMicros: 1_250_000,
        inputTokens: 100,
        outputTokens: 25,
        requestCount: 2,
      }),
    ]);

    const url = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
    expect(url.searchParams.get("group_by")).toBe("day");
    expect(url.searchParams.get("tags")).toBe("app:goat");
    expect(url.searchParams.get("tags_match")).toBe("all");
    expect(url.searchParams.get("user_id")).toMatch(/^goat-[0-9a-f]{16}$/);
  });

  it("returns contextual tag drilldown rows without summing all tags", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          results: [
            { tag: "chat:session_1", total_cost: 0.5, request_count: 1 },
            { tag: "task:task_1", total_cost: 0.75, request_count: 2 },
            { tag: "ingest:ingest_1", total_cost: 0.25, request_count: 1 },
            { tag: "feature:chat", total_cost: 1.5, request_count: 4 },
            { tag: "app:goat", total_cost: 1.5, request_count: 4 },
          ],
        }),
      ),
    );
    dbMock.getDb.mockReturnValue({
      select: vi
        .fn()
        .mockReturnValueOnce(selectRows([{ id: "session_1", title: "Pricing chat" }]))
        .mockReturnValueOnce(
          selectRows([{ id: "task_1", displayId: "TASK-1", name: "Research pricing" }]),
        )
        .mockReturnValueOnce(
          selectRows([{ id: "ingest_1", sourceProvider: "slack", status: "succeeded" }]),
        ),
    });

    await expect(
      getGoatUsageDrilldown({
        apiKey: "gateway-key",
        userWorkosId: "user_123",
        day: "2026-07-09",
      }),
    ).resolves.toEqual([
      {
        tag: "chat:session_1",
        kind: "chat",
        id: "session_1",
        label: "Pricing chat",
        href: "/chat/session_1",
        totalCostUsdMicros: 500_000,
        requestCount: 1,
      },
      {
        tag: "task:task_1",
        kind: "task",
        id: "task_1",
        label: "TASK-1 Research pricing",
        href: "/tasks/task_1",
        totalCostUsdMicros: 750_000,
        requestCount: 2,
      },
      {
        tag: "ingest:ingest_1",
        kind: "ingest",
        id: "ingest_1",
        label: "slack ingest (succeeded)",
        href: null,
        totalCostUsdMicros: 250_000,
        requestCount: 1,
      },
    ]);

    const url = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
    expect(url.searchParams.get("group_by")).toBe("tag");
  });
});

function selectRows(rows: unknown[]) {
  return {
    from: () => ({
      where: async () => rows,
    }),
  };
}
