import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  connectIntegration: vi.fn(),
  exchangeCode: vi.fn(),
  fetchIdentity: vi.fn(),
}));

vi.mock("@opencompany/db/goat-integrations", () => ({
  connectGoatLinearIngestIntegration: mocks.connectIntegration,
}));

vi.mock("@/lib/app-url", () => ({
  getGoatAppUrl: () => "https://localhost:3443",
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: () =>
    Promise.resolve({
      user: { workosUserId: "user_123" },
    }),
}));

vi.mock("@/lib/integrations/linear-ingest", () => ({
  appendGoatLinearIngestStatus: (returnTo: string, status: string, reason?: string) => {
    const url = new URL(returnTo, "https://localhost:3443");
    url.searchParams.set("integration", "linear");
    url.searchParams.set("setup", status);
    if (reason) url.searchParams.set("reason", reason);
    return `${url.pathname}${url.search}`;
  },
  exchangeGoatLinearCode: mocks.exchangeCode,
  fetchGoatLinearIdentity: mocks.fetchIdentity,
  isGoatLinearIngestConfigured: () => true,
  verifyGoatLinearIngestState: () => ({
    userWorkosId: "user_123",
    returnTo: "/onboarding/connected",
  }),
}));

describe("Goat Linear ingestion callback", () => {
  beforeEach(() => {
    mocks.connectIntegration.mockReset();
    mocks.exchangeCode.mockReset();
    mocks.fetchIdentity.mockReset();

    mocks.exchangeCode.mockResolvedValue({
      accessToken: "linear-access-token",
      scopes: ["read"],
    });
    mocks.fetchIdentity.mockResolvedValue({
      organizationId: "linear-org-123",
      organizationName: "Acme",
      organizationUrlKey: "acme",
      viewerId: "linear-user-123",
      viewerName: "Ada Lovelace",
      viewerEmail: "ada@example.com",
    });
  });

  it("returns to the canonical Goat HTTPS origin after a proxied local callback", async () => {
    const response = await GET(
      new Request(
        "https://localhost:3002/api/integrations/linear-ingest/callback?state=valid&code=code",
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://localhost:3443/onboarding/connected?integration=linear&setup=connected",
    );
    expect(mocks.connectIntegration).toHaveBeenCalledOnce();
  });
});
