import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAvailableHarnessTools } from "@/lib/integrations/google-data";

const mocks = vi.hoisted(() => ({
  orderBy: vi.fn(),
  getGitHubIntegrationState: vi.fn(),
  getLatitudeIntegrationState: vi.fn(),
  getLinearIntegrationState: vi.fn(),
  googleIntegrationStateFromRows: vi.fn(),
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
  googleIntegrationStateFromRows: mocks.googleIntegrationStateFromRows,
}));

vi.mock("@opencompany/core/integrations/github", () => ({
  getGitHubIntegrationState: mocks.getGitHubIntegrationState,
}));

vi.mock("@opencompany/core/integrations/linear-mcp", () => ({
  getLinearIntegrationState: mocks.getLinearIntegrationState,
}));

vi.mock("@/lib/integrations/latitude-mcp", () => ({
  getLatitudeIntegrationState: mocks.getLatitudeIntegrationState,
}));

describe("getAvailableHarnessTools", () => {
  const originalApifyToken = process.env.APIFY_API_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orderBy.mockResolvedValue([]);
    mocks.googleIntegrationStateFromRows.mockReturnValue({
      gmail: { connected: false },
      google_calendar: { connected: false },
    });
    mocks.getLinearIntegrationState.mockResolvedValue({ connected: false });
    mocks.getLatitudeIntegrationState.mockResolvedValue({ connected: false });
    mocks.getGitHubIntegrationState.mockResolvedValue({ connected: false });
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
    await expect(getAvailableHarnessTools("user_1")).resolves.toEqual(["exa_search"]);

    process.env.APIFY_API_TOKEN = "apify";

    await expect(getAvailableHarnessTools("user_1")).resolves.toEqual([
      "exa_search",
      "x_search_posts",
      "x_get_profile",
      "x_get_user_posts",
      "x_get_discussion",
      "social_get_job",
    ]);
  });
});
