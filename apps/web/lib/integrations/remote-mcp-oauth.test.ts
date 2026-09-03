import { createHmac } from "node:crypto";
import { auth } from "@ai-sdk/mcp";
import {
  loadIntegrationCredential,
  markIntegrationStatus,
  saveIntegrationCredential,
} from "@opencompany/db/integrations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  startBetterStackMcpOAuth,
  verifyBetterStackMcpState,
} from "@/lib/integrations/betterstack-mcp";
import {
  appendLatitudeMcpStatus,
  startLatitudeMcpOAuth,
  verifyLatitudeMcpState,
} from "@/lib/integrations/latitude-mcp";
import {
  getLinearIntegrationState,
  loadLinearMcpWorkerConnection,
  startLinearMcpOAuth,
  verifyLinearMcpState,
} from "@/lib/integrations/linear-mcp";
import { startNeonMcpOAuth, verifyNeonMcpState } from "@/lib/integrations/neon-mcp";
import { startPostHogMcpOAuth, verifyPostHogMcpState } from "@/lib/integrations/posthog-mcp";
import { startSigNozMcpOAuth, verifySigNozMcpState } from "@/lib/integrations/signoz-mcp";

const observed = vi.hoisted(() => ({
  callbackUrl: "",
  clientMetadata: null as unknown,
  state: "",
  dbRows: [] as unknown[],
  dbResults: [] as unknown[][],
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => observed.dbResults.shift() ?? observed.dbRows,
          }),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => [{ id: "gint_remote_mcp" }],
        }),
      }),
    }),
  }),
}));

vi.mock("@opencompany/db/integrations", () => ({
  loadIntegrationCredential: vi.fn(async () => null),
  markIntegrationStatus: vi.fn(async () => undefined),
  saveIntegrationCredential: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/agent/integrations/analytics", () => ({
  captureIntegrationAddedAnalytics: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/agent/app-url", () => ({
  getAppUrl: () => "https://opencompany.example",
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

describe("opencompany remote MCP OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MCP_OAUTH_STATE_SECRET", "test-state-secret");
    observed.callbackUrl = "";
    observed.clientMetadata = null;
    observed.state = "";
    observed.dbRows = [];
    observed.dbResults = [];
  });

  it("connects Latitude with dynamic registration and its documented endpoint", async () => {
    await expect(
      startLatitudeMcpOAuth({
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
    expect(observed.callbackUrl).toBe(
      "https://opencompany.example/api/integrations/latitude/callback",
    );
    expect(observed.clientMetadata).toMatchObject({
      client_name: "opencompany",
      redirect_uris: ["https://opencompany.example/api/integrations/latitude/callback"],
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(saveIntegrationCredential).toHaveBeenCalledWith(
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
    expect(verifyLatitudeMcpState(observed.state)).toMatchObject({
      provider: "latitude",
      userWorkosId: "user_1",
      returnTo: "/settings/integrations",
    });
    expect(() => verifyLinearMcpState(observed.state)).toThrow(
      "Invalid Linear MCP provider state.",
    );
  });

  it("preserves Linear's explicit read/write scope in registered client metadata", async () => {
    await startLinearMcpOAuth({
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

  it("connects PostHog with only the analytics scopes and tools opencompany exposes", async () => {
    await startPostHogMcpOAuth({
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
    expect(observed.callbackUrl).toBe(
      "https://opencompany.example/api/integrations/posthog/callback",
    );
    expect(observed.clientMetadata).toMatchObject({
      scope:
        "dashboard:read insight:read query:read event_definition:read property_definition:read insight:write",
    });
    expect(verifyPostHogMcpState(observed.state)).toMatchObject({
      provider: "posthog",
      userWorkosId: "user_1",
      returnTo: "/settings/integrations",
    });
  });

  it("connects Neon with read-only OAuth and provider-side tool categories", async () => {
    await startNeonMcpOAuth({
      userWorkosId: "user_1",
      returnTo: "/settings/integrations",
    });

    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        serverUrl:
          "https://mcp.neon.tech/mcp?readonly=true&category=projects&category=branches&category=schema&category=querying",
      }),
    );
    expect(observed.callbackUrl).toBe("https://opencompany.example/api/integrations/neon/callback");
    expect(observed.clientMetadata).toMatchObject({ scope: "read" });
    expect(verifyNeonMcpState(observed.state)).toMatchObject({
      provider: "neon",
      userWorkosId: "user_1",
      returnTo: "/settings/integrations",
    });
  });

  it("connects Better Stack to its public hosted MCP with read and write OAuth", async () => {
    await startBetterStackMcpOAuth({
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/betterstack",
    });

    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ serverUrl: "https://mcp.betterstack.com" }),
    );
    expect(vi.mocked(auth).mock.calls[0]?.[1]).not.toHaveProperty("scope");
    expect(observed.callbackUrl).toBe(
      "https://opencompany.example/api/integrations/betterstack/callback",
    );
    expect(observed.clientMetadata).toMatchObject({ scope: "read write" });
    expect(verifyBetterStackMcpState(observed.state)).toMatchObject({
      provider: "betterstack",
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/betterstack",
    });
    expect(() => verifyLinearMcpState(observed.state)).toThrow(
      "Invalid Linear MCP provider state.",
    );
  });

  it("connects SigNoz only to the reviewed US Cloud MCP endpoint", async () => {
    await startSigNozMcpOAuth({
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/signoz",
    });

    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ serverUrl: "https://mcp.us.signoz.cloud/mcp" }),
    );
    expect(observed.clientMetadata).not.toHaveProperty("scope");
    expect(observed.callbackUrl).toBe(
      "https://opencompany.example/api/integrations/signoz/callback",
    );
    expect(verifySigNozMcpState(observed.state)).toMatchObject({
      provider: "signoz",
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/signoz",
    });
  });

  it("accepts provider-less legacy state only for Linear", async () => {
    await startLinearMcpOAuth({
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

    expect(verifyLinearMcpState(legacyState)).toMatchObject({
      userWorkosId: "user_1",
      returnTo: "/settings/integrations",
    });
    expect(() => verifyLatitudeMcpState(legacyState)).toThrow(
      "Invalid Latitude MCP provider state.",
    );
  });

  it("sanitizes off-site callback return paths", () => {
    expect(appendLatitudeMcpStatus("//evil.example", "connected")).toBe(
      "/settings?integration=latitude&setup=connected",
    );
  });

  it("marks remote MCP connections as needing reconnect when stored OAuth data is missing", async () => {
    observed.dbRows = [{ id: "gint_linear", userWorkosId: "user_1", status: "connected" }];

    await expect(
      loadLinearMcpWorkerConnection({
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("unexpected authorization redirect");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });

    expect(markIntegrationStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        integrationId: "gint_linear",
        provider: "linear",
        status: "needs_reauth",
        statusReason: "Linear needs to be reconnected before opencompany can use it.",
      }),
    );
  });

  it("marks remote MCP connections as needing reconnect when OAuth credentials are invalidated", async () => {
    observed.dbRows = [{ id: "gint_linear", userWorkosId: "user_1", status: "connected" }];
    vi.mocked(loadIntegrationCredential).mockResolvedValueOnce({
      payload: {
        clientInformation: { client_id: "dynamic_client" },
        tokens: { access_token: "stale_token", token_type: "Bearer" },
      },
      expiresAt: null,
      lastRotatedAt: null,
      updatedAt: new Date("2026-08-03T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    });

    const connection = await loadLinearMcpWorkerConnection({
      userWorkosId: "user_1",
      onAuthorizationRequired: () => {
        throw new Error("unexpected authorization redirect");
      },
    });
    if (!connection.ok) throw new Error("expected Linear connection");
    if (!connection.authProvider.invalidateCredentials) {
      throw new Error("expected invalidation support");
    }

    await connection.authProvider.invalidateCredentials("tokens");

    expect(saveIntegrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        integrationId: "gint_linear",
        provider: "linear",
        payload: expect.not.objectContaining({ tokens: expect.anything() }),
      }),
    );
    expect(markIntegrationStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        integrationId: "gint_linear",
        provider: "linear",
        status: "needs_reauth",
        statusReason: "Linear authorization expired. Reconnect Linear in Settings.",
      }),
    );
  });

  it("reports existing remote MCP reauth states distinctly from missing connections", async () => {
    observed.dbRows = [{ id: "gint_linear", userWorkosId: "user_1", status: "needs_reauth" }];

    await expect(
      loadLinearMcpWorkerConnection({
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("unexpected authorization redirect");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });

    expect(markIntegrationStatus).not.toHaveBeenCalled();
  });

  it("prefers the acting user's connection and falls back to the workspace connection", async () => {
    observed.dbResults = [
      [
        {
          id: "gint_personal",
          userWorkosId: "user_1",
          status: "connected",
          accountName: "Personal Linear",
          statusReason: null,
          capabilityModes: { read: "on" },
          toolModes: { list_issues: "on" },
        },
      ],
    ];
    await expect(
      getLinearIntegrationState({ userWorkosId: "user_1", workspaceId: "workspace_1" }),
    ).resolves.toMatchObject({
      integrationId: "gint_personal",
      accountName: "Personal Linear",
      toolModes: { list_issues: "on" },
    });

    observed.dbResults = [
      [],
      [
        {
          id: "gint_workspace",
          userWorkosId: "workspace_admin",
          status: "connected",
          accountName: "Workspace Linear",
          statusReason: null,
          capabilityModes: { read: "ask" },
          toolModes: {},
        },
      ],
    ];
    await expect(
      getLinearIntegrationState({ userWorkosId: "user_1", workspaceId: "workspace_1" }),
    ).resolves.toMatchObject({
      integrationId: "gint_workspace",
      accountName: "Workspace Linear",
      capabilityModes: { read: "ask" },
    });

    observed.dbResults = [
      [],
      [
        {
          id: "gint_workspace",
          userWorkosId: "workspace_admin",
          status: "connected",
          accountName: "Workspace Linear",
          statusReason: null,
          capabilityModes: {},
          toolModes: {},
        },
      ],
    ];
    await expect(
      loadLinearMcpWorkerConnection({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
    expect(loadIntegrationCredential).toHaveBeenLastCalledWith(
      expect.objectContaining({ userWorkosId: "workspace_admin" }),
    );
    expect(markIntegrationStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ userWorkosId: "workspace_admin" }),
    );
  });
});
