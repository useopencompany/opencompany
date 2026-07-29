import { createHmac } from "node:crypto";
import { auth } from "@ai-sdk/mcp";
import { saveGoatIntegrationCredential } from "@opencompany/db/goat-integrations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendGoatLatitudeMcpStatus,
  startGoatLatitudeMcpOAuth,
  verifyGoatLatitudeMcpState,
} from "@/lib/integrations/latitude-mcp";
import { startGoatLinearMcpOAuth, verifyGoatLinearMcpState } from "@/lib/integrations/linear-mcp";
import {
  startGoatPostHogMcpOAuth,
  verifyGoatPostHogMcpState,
} from "@/lib/integrations/posthog-mcp";

const observed = vi.hoisted(() => ({
  callbackUrl: "",
  clientMetadata: null as unknown,
  state: "",
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => [{ id: "gint_remote_mcp" }],
        }),
      }),
    }),
  }),
}));

vi.mock("@opencompany/db/goat-integrations", () => ({
  loadGoatIntegrationCredential: vi.fn(async () => null),
  saveGoatIntegrationCredential: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/goat-agent/integrations/analytics", () => ({
  captureGoatIntegrationAddedAnalytics: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/goat-agent/app-url", () => ({
  getGoatAppUrl: () => "https://goat.example",
}));

vi.mock("@ai-sdk/mcp", () => ({
  auth: vi.fn(async (provider) => {
    observed.callbackUrl = provider.redirectUrl;
    observed.clientMetadata = provider.clientMetadata;
    observed.state = provider.state();
    await provider.saveClientInformation({ client_id: "dynamic_client" });
    await provider.saveCodeVerifier("verifier");
    await provider.saveState(observed.state);
    provider.redirectToAuthorization(new URL("https://provider.example/oauth"));
    return "REDIRECT";
  }),
}));

describe("Goat remote MCP OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MCP_OAUTH_STATE_SECRET", "test-state-secret");
    observed.callbackUrl = "";
    observed.clientMetadata = null;
    observed.state = "";
  });

  it("connects Latitude with dynamic registration and its documented endpoint", async () => {
    await expect(
      startGoatLatitudeMcpOAuth({
        userWorkosId: "user_1",
        returnTo: "/settings/integrations",
      }),
    ).resolves.toEqual({
      status: "redirect",
      redirectUrl: "https://provider.example/oauth",
    });

    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        serverUrl: "https://api.latitude.so/v1/mcp",
      }),
    );
    expect(vi.mocked(auth).mock.calls[0]?.[1]).not.toHaveProperty("scope");
    expect(observed.callbackUrl).toBe("https://goat.example/api/integrations/latitude/callback");
    expect(observed.clientMetadata).toMatchObject({
      client_name: "OpenCompany Goat",
      redirect_uris: ["https://goat.example/api/integrations/latitude/callback"],
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(saveGoatIntegrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        integrationId: "gint_remote_mcp",
        provider: "latitude",
        kind: "oauth_token",
        payload: expect.objectContaining({
          clientInformation: { client_id: "dynamic_client" },
        }),
      }),
    );
    expect(verifyGoatLatitudeMcpState(observed.state)).toMatchObject({
      provider: "latitude",
      userWorkosId: "user_1",
      returnTo: "/settings/integrations",
    });
    expect(() => verifyGoatLinearMcpState(observed.state)).toThrow(
      "Invalid Linear MCP provider state.",
    );
  });

  it("preserves Linear's explicit read/write scope in registered client metadata", async () => {
    await startGoatLinearMcpOAuth({
      userWorkosId: "user_1",
      returnTo: "/settings/integrations",
    });

    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        serverUrl: "https://mcp.linear.app/mcp",
      }),
    );
    expect(vi.mocked(auth).mock.calls[0]?.[1]).not.toHaveProperty("scope");
    expect(observed.clientMetadata).toMatchObject({ scope: "read write" });
  });

  it("connects PostHog with only the analytics scopes and tools Goat exposes", async () => {
    await startGoatPostHogMcpOAuth({
      userWorkosId: "user_1",
      returnTo: "/settings/integrations",
    });

    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        serverUrl: expect.stringMatching(/^https:\/\/mcp\.posthog\.com\/mcp\?mode=tools&tools=/),
      }),
    );
    const serverUrl = String(vi.mocked(auth).mock.calls[0]?.[1]?.serverUrl);
    expect(serverUrl).toContain("dashboards-get-all");
    expect(serverUrl).toContain("insight-create");
    expect(serverUrl).not.toContain("feature-flag");
    expect(observed.callbackUrl).toBe("https://goat.example/api/integrations/posthog/callback");
    expect(observed.clientMetadata).toMatchObject({
      scope:
        "dashboard:read insight:read query:read event_definition:read property_definition:read insight:write",
    });
    expect(verifyGoatPostHogMcpState(observed.state)).toMatchObject({
      provider: "posthog",
      userWorkosId: "user_1",
      returnTo: "/settings/integrations",
    });
  });

  it("accepts provider-less legacy state only for Linear", async () => {
    await startGoatLinearMcpOAuth({
      userWorkosId: "user_1",
      returnTo: "/settings/integrations",
    });
    const [body] = observed.state.split(".");
    const legacyPayload = JSON.parse(
      Buffer.from(body ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    delete legacyPayload.provider;
    const legacyBody = Buffer.from(JSON.stringify(legacyPayload), "utf8").toString("base64url");
    const signature = createHmac("sha256", "test-state-secret")
      .update(legacyBody)
      .digest("base64url");
    const legacyState = `${legacyBody}.${signature}`;

    expect(verifyGoatLinearMcpState(legacyState)).toMatchObject({
      userWorkosId: "user_1",
      returnTo: "/settings/integrations",
    });
    expect(() => verifyGoatLatitudeMcpState(legacyState)).toThrow(
      "Invalid Latitude MCP provider state.",
    );
  });

  it("sanitizes off-site callback return paths", () => {
    expect(appendGoatLatitudeMcpStatus("//evil.example", "connected")).toBe(
      "/settings?integration=latitude&setup=connected",
    );
  });
});
