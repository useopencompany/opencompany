import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { getGoatDailyUsage, getGoatUsageDrilldown } from "@/lib/gateway-usage";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/gateway-usage", () => ({
  getGoatDailyUsage: vi.fn(),
  getGoatUsageDrilldown: vi.fn(),
}));

describe("GET /api/usage/daily", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.mocked(currentGoatUser as unknown as () => Promise<unknown>).mockResolvedValue({
      user: { workosUserId: "user_123" },
    });
    vi.mocked(getGoatDailyUsage).mockResolvedValue([
      {
        day: "2026-07-09",
        totalCostUsdMicros: 1000,
        marketCostUsdMicros: 1000,
        surchargeCostUsdMicros: 0,
        gatewayCostUsdMicros: 0,
        inputTokens: 10,
        outputTokens: 2,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        requestCount: 1,
      },
    ]);
    vi.mocked(getGoatUsageDrilldown).mockResolvedValue([
      {
        tag: "chat:session_1",
        kind: "chat",
        id: "session_1",
        label: "Chat",
        href: "/chat/session_1",
        totalCostUsdMicros: 1000,
        requestCount: 1,
      },
    ]);
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "gateway-key");
  });

  it("returns daily usage and optional drilldown for the current user", async () => {
    const response = await GET(
      new Request(
        "http://goat.test/api/usage/daily?start=2026-07-09&end=2026-07-09&day=2026-07-09",
      ),
    );

    await expect(response.json()).resolves.toEqual({
      timezone: "UTC",
      start: "2026-07-09",
      end: "2026-07-09",
      days: [expect.objectContaining({ day: "2026-07-09", totalCostUsdMicros: 1000 })],
      drilldown: {
        day: "2026-07-09",
        items: [expect.objectContaining({ tag: "chat:session_1" })],
      },
    });
    expect(getGoatDailyUsage).toHaveBeenCalledWith({
      apiKey: "gateway-key",
      userWorkosId: "user_123",
      start: "2026-07-09",
      end: "2026-07-09",
    });
  });

  it("rejects invalid date ranges before querying Gateway", async () => {
    const response = await GET(
      new Request("http://goat.test/api/usage/daily?start=2026-07-10&end=2026-07-09"),
    );

    expect(response.status).toBe(400);
    expect(getGoatDailyUsage).not.toHaveBeenCalled();
  });

  it("rejects normalized but invalid calendar dates", async () => {
    const response = await GET(
      new Request("http://goat.test/api/usage/daily?start=2026-02-31&end=2026-02-31"),
    );

    expect(response.status).toBe(400);
    expect(getGoatDailyUsage).not.toHaveBeenCalled();
  });
});
