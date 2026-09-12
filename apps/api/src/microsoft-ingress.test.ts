import { captureConnectionAddedAnalytics } from "@opencompany/agent/integrations/analytics";
import {
  createMicrosoftIntegrationState,
  exchangeMicrosoftCode,
  fetchMicrosoftUserInfo,
} from "@opencompany/agent/integrations/microsoft-oauth";
import { connectMicrosoftIntegration } from "@opencompany/db/integrations";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createMicrosoftIngress } from "./microsoft-ingress";

vi.mock("@opencompany/agent/integrations/microsoft-oauth", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  exchangeMicrosoftCode: vi.fn(),
  fetchMicrosoftUserInfo: vi.fn(),
}));
vi.mock("@opencompany/db/integrations", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  connectMicrosoftIntegration: vi.fn(),
}));
vi.mock("@opencompany/db/workspaces", () => ({ listWorkspacesForUser: vi.fn() }));
vi.mock("@opencompany/agent/integrations/analytics", () => ({
  captureConnectionAddedAnalytics: vi.fn(),
}));
const refresh = vi.fn();
function ingress(anonymous = false) {
  return createMicrosoftIngress({
    db: {},
    refreshPluginRegistrations: refresh,
    identify: async () => {
      if (anonymous) throw new ApiError(401, "authentication_required", "Sign in");
      return {
        userId: "user_1",
        organizationId: null,
        method: "session",
        credentialKind: "browser_cookie",
        activeWorkspaceId: null,
        activeBrainId: null,
      };
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://app.example.com");
  for (const key of [
    "MICROSOFT_OAUTH_CLIENT_ID",
    "MICROSOFT_OAUTH_CLIENT_SECRET",
    "MICROSOFT_INTEGRATION_STATE_SECRET",
    "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
  ])
    vi.stubEnv(key, "test-value");
  vi.mocked(listWorkspacesForUser).mockResolvedValue([
    { workspace: { id: "w1", workosOrganizationId: null }, role: "member" },
  ] as never);
  vi.mocked(exchangeMicrosoftCode).mockResolvedValue({
    tokens: {
      access_token: "private-access",
      refresh_token: "private-refresh",
      scope: "User.Read Mail.ReadWrite",
      token_type: "Bearer",
    },
    expiresAt: new Date(Date.now() + 3600000),
  });
  vi.mocked(fetchMicrosoftUserInfo).mockResolvedValue({
    id: "ms-user",
    mail: "test@outlook.com",
    displayName: "Test",
  });
  vi.mocked(connectMicrosoftIntegration).mockResolvedValue({ integrationId: "i1" });
});
afterEach(() => vi.unstubAllEnvs());
function callback(
  provider = "outlook",
  userWorkosId = "user_1",
  stateProvider: "outlook" | "outlook-calendar" = "outlook",
) {
  const url = new URL(`https://api.example.com/integrations/${provider}/callback`);
  url.searchParams.set(
    "state",
    createMicrosoftIntegrationState({
      provider: stateProvider,
      userWorkosId,
      returnTo: "/settings/plugins/outlook",
    }),
  );
  url.searchParams.set("code", "one-time-code");
  return new Request(url);
}
describe("Microsoft OAuth ingress", () => {
  it("redirects to Microsoft with PKCE and preserves the public web callback", async () => {
    const response = await ingress().start(
      "outlook",
      new Request("https://api.example.com/integrations/outlook/start"),
    );
    const url = new URL(response.headers.get("location")!);
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/integrations/outlook/callback",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
  it("requires a session and reports missing configuration", async () => {
    const request = new Request("https://api.example.com/integrations/outlook/start");
    expect((await ingress(true).start("outlook", request)).headers.get("location")).toBe(
      "https://app.example.com/signin",
    );
    vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "");
    expect((await ingress().start("outlook", request)).headers.get("location")).toContain(
      "reason=not_configured",
    );
  });
  it("sanitizes an overlong return path before creating OAuth state", async () => {
    const request = new Request(
      `https://api.example.com/integrations/outlook/start?returnTo=/${"a".repeat(3000)}`,
    );
    const response = await ingress().start("outlook", request);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("login.microsoftonline.com");
  });
  it("rejects provider and session substitution before exchanging a code", async () => {
    for (const req of [
      callback("outlook", "other-user"),
      callback("outlook", "user_1", "outlook-calendar"),
    ]) {
      expect((await ingress().callback("outlook", req)).headers.get("location")).toContain(
        "reason=session_mismatch",
      );
    }
    expect(exchangeMicrosoftCode).not.toHaveBeenCalled();
  });
  it("persists credentials in the vault and refreshes discovery without exposing tokens in redirects", async () => {
    const response = await ingress().callback("outlook", callback());
    expect(connectMicrosoftIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "outlook",
        externalId: "ms-user",
        userWorkosId: "user_1",
        tokens: expect.objectContaining({ refresh_token: "private-refresh" }),
      }),
    );
    expect(refresh).toHaveBeenCalledWith({
      provider: "outlook",
      userWorkosId: "user_1",
      workspaceIds: ["w1"],
    });
    expect(response.headers.get("location")).toBe(
      "https://app.example.com/settings/plugins/outlook?integration=outlook&setup=connected",
    );
  });
  it("handles denied consent without code exchange", async () => {
    const url = new URL(callback().url);
    url.searchParams.set("error", "access_denied");
    expect(
      (await ingress().callback("outlook", new Request(url))).headers.get("location"),
    ).toContain("reason=microsoft_denied");
    expect(exchangeMicrosoftCode).not.toHaveBeenCalled();
  });
  it("keeps a successful connection when discovery refresh fails", async () => {
    refresh.mockRejectedValueOnce(new Error("discovery unavailable"));
    expect((await ingress().callback("outlook", callback())).headers.get("location")).toContain(
      "setup=connected",
    );
  });
  it("keeps a successful connection when analytics fails", async () => {
    vi.mocked(captureConnectionAddedAnalytics).mockRejectedValueOnce(
      new Error("analytics unavailable"),
    );
    expect((await ingress().callback("outlook", callback())).headers.get("location")).toContain(
      "setup=connected",
    );
    expect(refresh).toHaveBeenCalled();
  });
});
