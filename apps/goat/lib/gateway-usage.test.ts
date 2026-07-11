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

  it("sums Vercel daily report rows across workspace users", async () => {
    const responses = [
      {
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
      },
      {
        results: [
          {
            day: "2026-07-09",
            total_cost: 0.75,
            market_cost: 0.75,
            surcharge_cost: 0,
            gateway_cost: 0,
            input_tokens: 50,
            output_tokens: 10,
            cached_input_tokens: 5,
            cache_creation_input_tokens: 2,
            reasoning_tokens: 1,
            request_count: 1,
          },
        ],
      },
      { results: [{ day: "2026-07-09", total_cost: 0.5 }] },
      { results: [{ day: "2026-07-09", total_cost: 0.125 }] },
      { results: [{ day: "2026-07-09", total_cost: 0.25 }] },
      { results: [{ day: "2026-07-09", total_cost: 0.2 }] },
      { results: [{ day: "2026-07-09", total_cost: 0.175 }] },
      { results: [{ day: "2026-07-09", total_cost: 0.1 }] },
      { results: [{ day: "2026-07-09", total_cost: 0.05 }] },
      { results: [{ day: "2026-07-09", total_cost: 0.2 }] },
      { results: [{ day: "2026-07-09", total_cost: 0.03 }] },
      { results: [{ day: "2026-07-09", total_cost: 0.02 }] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(responses.shift() ?? { results: [] })),
    );

    await expect(
      getGoatDailyUsage({
        apiKey: "gateway-key",
        userWorkosIds: ["user_123", "user_456"],
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
        totalCostUsdMicros: 2_000_000,
        chatCostUsdMicros: 775_000,
        taskCostUsdMicros: 450_000,
        brainCostUsdMicros: 425_000,
        inputTokens: 150,
        outputTokens: 35,
        requestCount: 3,
      }),
    ]);

    const url = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
    expect(url.searchParams.get("group_by")).toBe("day");
    expect(url.searchParams.get("tags")).toBe("app:goat");
    expect(url.searchParams.get("tags_match")).toBe("all");
    expect(url.searchParams.get("user_id")).toMatch(/^goat-[0-9a-f]{16}$/);
    const secondUserUrl = new URL(String(vi.mocked(fetch).mock.calls[1]?.[0]));
    expect(secondUserUrl.searchParams.get("user_id")).toMatch(/^goat-[0-9a-f]{16}$/);
    expect(secondUserUrl.searchParams.get("user_id")).not.toBe(url.searchParams.get("user_id"));
    const featureTags = vi
      .mocked(fetch)
      .mock.calls.slice(2)
      .map((call) => new URL(String(call[0])).searchParams.get("tags"));
    expect(featureTags).toEqual([
      "app:goat,feature:chat",
      "app:goat,feature:chat-title",
      "app:goat,feature:task",
      "app:goat,feature:brain-ingest",
      "app:goat,feature:brain-query",
      "app:goat,feature:chat",
      "app:goat,feature:chat-title",
      "app:goat,feature:task",
      "app:goat,feature:brain-ingest",
      "app:goat,feature:brain-query",
    ]);
  });

  it("returns contextual tag drilldown rows across workspace users without leaking labels", async () => {
    const responses = [
      {
        results: [
          { tag: "chat:session_1", total_cost: 0.5, request_count: 1 },
          { tag: "task:task_1", total_cost: 0.75, request_count: 2 },
          { tag: "ingest:ingest_1", total_cost: 0.25, request_count: 1 },
          { tag: "feature:chat", total_cost: 1.5, request_count: 4 },
          { tag: "app:goat", total_cost: 1.5, request_count: 4 },
        ],
      },
      {
        results: [{ tag: "chat:session_2", total_cost: 0.125, request_count: 1 }],
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(responses.shift() ?? { results: [] })),
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
        userWorkosIds: ["user_123", "user_456"],
        currentUserWorkosId: "user_123",
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
      {
        tag: "chat:session_2",
        kind: "chat",
        id: "session_2",
        label: "Chat usage",
        href: null,
        totalCostUsdMicros: 125_000,
        requestCount: 1,
      },
    ]);

    const url = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
    expect(url.searchParams.get("group_by")).toBe("tag");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});

function selectRows(rows: unknown[]) {
  return {
    from: () => ({
      where: async () => rows,
    }),
  };
}
