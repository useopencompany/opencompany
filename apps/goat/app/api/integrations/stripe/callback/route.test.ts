import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { captureGoatIntegrationAddedAnalytics } from "@/lib/integrations/analytics";
import {
  connectGoatStripeIntegration,
  exchangeGoatStripeOAuthCode,
  validateGoatStripeOAuthAccess,
  verifyGoatStripeOAuthState,
} from "@/lib/integrations/stripe";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/integrations/analytics", () => ({
  captureGoatIntegrationAddedAnalytics: vi.fn(),
}));

vi.mock("@/lib/integrations/stripe", () => ({
  appendGoatStripeIntegrationStatus: vi.fn(
    (_returnTo: string, status: string, reason?: string) =>
      `/settings/integrations?integration=stripe&setup=${status}${reason ? `&reason=${reason}` : ""}`,
  ),
  connectGoatStripeIntegration: vi.fn(),
  exchangeGoatStripeOAuthCode: vi.fn(),
  isGoatStripeOAuthConfigured: vi.fn(() => true),
  validateGoatStripeOAuthAccess: vi.fn(),
  verifyGoatStripeOAuthState: vi.fn(),
}));

const currentGoatUserMock = vi.mocked(currentGoatUser);
const captureAnalyticsMock = vi.mocked(captureGoatIntegrationAddedAnalytics);
const connectMock = vi.mocked(connectGoatStripeIntegration);
const exchangeCodeMock = vi.mocked(exchangeGoatStripeOAuthCode);
const validateAccessMock = vi.mocked(validateGoatStripeOAuthAccess);
const verifyStateMock = vi.mocked(verifyGoatStripeOAuthState);

const tokens = {
  accessToken: "oauth-access-token",
  refreshToken: "oauth-refresh-token",
  accountId: "acct_123",
  livemode: true,
  scope: "stripe_apps",
  expiresAt: new Date("2026-07-27T13:00:00Z"),
};
const identity = {
  accountId: "acct_123",
  accountName: "Acme Payments",
  accountEmail: "finance@example.com",
  country: "US",
  livemode: true,
};

function context(role: "admin" | "member" = "admin") {
  return {
    role,
    user: { workosUserId: "user_1" },
    workspace: { id: "workspace_1" },
  } as never;
}

describe("Stripe OAuth callback route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentGoatUserMock.mockResolvedValue(context());
    verifyStateMock.mockReturnValue({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      returnTo: "/settings/integrations",
      redirectUri: "https://goat.example.com/api/integrations/stripe/callback",
      expiresAt: Date.now() + 60_000,
      nonce: "nonce",
    });
    exchangeCodeMock.mockResolvedValue(tokens);
    validateAccessMock.mockResolvedValue({ ok: true, identity });
    connectMock.mockResolvedValue({ integrationId: "gint_stripe" });
    captureAnalyticsMock.mockResolvedValue(undefined);
  });

  it("exchanges, validates, and persists the Stripe OAuth grant", async () => {
    const response = await GET(
      new Request(
        "https://goat.example.com/api/integrations/stripe/callback?code=ac_123&state=signed",
      ),
    );

    expect(exchangeCodeMock).toHaveBeenCalledWith("ac_123");
    expect(validateAccessMock).toHaveBeenCalledWith(tokens);
    expect(connectMock).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      tokens,
      identity,
    });
    expect(captureAnalyticsMock).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      provider: "stripe",
    });
    expect(response.headers.get("location")).toContain("setup=connected");
  });

  it("rejects a callback for a different active workspace", async () => {
    currentGoatUserMock.mockResolvedValue({
      role: "admin",
      user: { workosUserId: "user_1" },
      workspace: { id: "workspace_2" },
    } as never);

    const response = await GET(
      new Request(
        "https://goat.example.com/api/integrations/stripe/callback?code=ac_123&state=signed",
      ),
    );

    expect(response.headers.get("location")).toContain("reason=session_mismatch");
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it("does not persist a grant missing required app permissions", async () => {
    validateAccessMock.mockResolvedValue({
      ok: false,
      error: "The Stripe app was not granted read access to invoices.",
      reason: "missing_permissions",
    });

    const response = await GET(
      new Request(
        "https://goat.example.com/api/integrations/stripe/callback?code=ac_123&state=signed",
      ),
    );

    expect(response.headers.get("location")).toContain("reason=missing_permissions");
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("does not misreport a transient Stripe failure as missing permissions", async () => {
    validateAccessMock.mockResolvedValue({
      ok: false,
      error: "Could not reach Stripe. Try again in a moment.",
      reason: "provider_unavailable",
    });

    const response = await GET(
      new Request(
        "https://goat.example.com/api/integrations/stripe/callback?code=ac_123&state=signed",
      ),
    );

    expect(response.headers.get("location")).toContain("reason=connection_sync_failed");
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("rejects invalid signed state before exchanging the code", async () => {
    verifyStateMock.mockImplementation(() => {
      throw new Error("bad state");
    });

    const response = await GET(
      new Request(
        "https://goat.example.com/api/integrations/stripe/callback?code=ac_123&state=bad",
      ),
    );

    expect(response.headers.get("location")).toContain("reason=invalid_state");
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });
});
