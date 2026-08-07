import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGoatAvailableHarnessTools } from "@/lib/integrations/google-data";

const mocks = vi.hoisted(() => ({
  orderBy: vi.fn(),
  getGoatGitHubIntegrationState: vi.fn(),
  getGoatLatitudeIntegrationState: vi.fn(),
  getGoatLinearIntegrationState: vi.fn(),
  goatGoogleIntegrationStateFromRows: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: mocks.orderBy,
        }),
      }),
    }),
  }),
}));

vi.mock("@opencompany/core/integration-state", () => ({
  goatGoogleIntegrationStateFromRows: mocks.goatGoogleIntegrationStateFromRows,
}));

vi.mock("@opencompany/core/integrations/github", () => ({
  getGoatGitHubIntegrationState: mocks.getGoatGitHubIntegrationState,
}));

vi.mock("@opencompany/core/integrations/linear-mcp", () => ({
  getGoatLinearIntegrationState: mocks.getGoatLinearIntegrationState,
}));

vi.mock("@/lib/integrations/latitude-mcp", () => ({
  getGoatLatitudeIntegrationState: mocks.getGoatLatitudeIntegrationState,
}));

describe("getGoatAvailableHarnessTools", () => {
  const originalApifyToken = process.env.APIFY_API_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orderBy.mockResolvedValue([]);
    mocks.goatGoogleIntegrationStateFromRows.mockReturnValue({
      gmail: { connected: false },
      google_calendar: { connected: false },
    });
    mocks.getGoatLinearIntegrationState.mockResolvedValue({ connected: false });
    mocks.getGoatLatitudeIntegrationState.mockResolvedValue({ connected: false });
    mocks.getGoatGitHubIntegrationState.mockResolvedValue({ connected: false });
    delete process.env.APIFY_API_TOKEN;
  });

  afterEach(() => {
    if (originalApifyToken === undefined) {
      delete process.env.APIFY_API_TOKEN;
    } else {
      process.env.APIFY_API_TOKEN = originalApifyToken;
    }
  });

  it("includes X tools only when APIFY_API_TOKEN is configured", async () => {
    await expect(getGoatAvailableHarnessTools("user_1")).resolves.toEqual(["exa_search"]);

    process.env.APIFY_API_TOKEN = "apify";

    await expect(getGoatAvailableHarnessTools("user_1")).resolves.toEqual([
      "exa_search",
      "x_search_posts",
      "x_get_profile",
      "x_get_user_posts",
      "x_get_discussion",
      "social_get_job",
    ]);
  });
});
