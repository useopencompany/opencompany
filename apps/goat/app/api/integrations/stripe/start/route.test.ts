import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatStripeIntegrationStatus,
  buildGoatStripeOAuthAuthorizationUrl,
  createGoatStripeOAuthState,
  goatStripeOAuthRedirectUri,
  isGoatStripeOAuthConfigured,
} from "@/lib/integrations/stripe";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/integrations/stripe", () => ({
  appendGoatStripeIntegrationStatus: vi.fn(
    (_returnTo: string, status: string, reason?: string) =>
      `/settings/integrations?integration=stripe&setup=${status}${reason ? `&reason=${reason}` : ""}`,
  ),
  buildGoatStripeOAuthAuthorizationUrl: vi.fn(() => "https://marketplace.stripe.com/oauth/start"),
  createGoatStripeOAuthState: vi.fn(() => "signed-state"),
  goatStripeOAuthRedirectUri: vi.fn(
    () => "https://goat.example.com/api/integrations/stripe/callback",
  ),
  isGoatStripeOAuthConfigured: vi.fn(() => true),
}));

const currentGoatUserMock = vi.mocked(currentGoatUser);
const isConfiguredMock = vi.mocked(isGoatStripeOAuthConfigured);
const createStateMock = vi.mocked(createGoatStripeOAuthState);
const buildAuthorizationUrlMock = vi.mocked(buildGoatStripeOAuthAuthorizationUrl);

function context(role: "admin" | "member" = "admin") {
  return {
    role,
    user: { workosUserId: "user_1" },
    workspace: { id: "workspace_1" },
  } as never;
}

describe("Stripe OAuth start route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentGoatUserMock.mockResolvedValue(context());
    isConfiguredMock.mockReturnValue(true);
  });

  it("redirects an admin to the Stripe Apps OAuth consent flow", async () => {
    const response = await GET(
      new Request(
        "https://goat.example.com/api/integrations/stripe/start?returnTo=/settings/stripe",
      ),
    );

    expect(response.headers.get("location")).toBe("https://marketplace.stripe.com/oauth/start");
    expect(createStateMock).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      returnTo: "/settings/stripe",
      redirectUri: "https://goat.example.com/api/integrations/stripe/callback",
    });
    expect(buildAuthorizationUrlMock).toHaveBeenCalledWith(
      "signed-state",
      "https://goat.example.com/api/integrations/stripe/callback",
    );
    expect(goatStripeOAuthRedirectUri).toHaveBeenCalled();
  });

  it("rejects non-admin workspace members before creating OAuth state", async () => {
    currentGoatUserMock.mockResolvedValue(context("member"));

    const response = await GET(
      new Request("https://goat.example.com/api/integrations/stripe/start"),
    );

    expect(response.headers.get("location")).toContain("reason=admin_required");
    expect(createStateMock).not.toHaveBeenCalled();
  });

  it("returns an actionable redirect when Stripe OAuth is not configured", async () => {
    isConfiguredMock.mockReturnValue(false);

    const response = await GET(
      new Request("https://goat.example.com/api/integrations/stripe/start"),
    );

    expect(response.headers.get("location")).toContain("reason=not_configured");
    expect(appendGoatStripeIntegrationStatus).toHaveBeenCalled();
  });
});
